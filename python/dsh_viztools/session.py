"""Read a DSH JSONL trajectory into analysis-friendly rows.

The loader intentionally reads the physical append-only log without mutating or
migrating it. It supports plaintext and concatenated-Zstandard generations and
keeps the complete decoded records available for auditability.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import json
from pathlib import Path
from typing import Any, Iterable, Iterator


def _records(path: Path) -> Iterator[dict[str, Any]]:
    if path.name.endswith(".zstd"):
        try:
            import zstandard
        except ImportError as exc:  # pragma: no cover - dependency is installed by plugin
            raise RuntimeError("zstandard is required to read compressed DSH sessions") from exc
        with path.open("rb") as raw, zstandard.ZstdDecompressor().stream_reader(raw, read_across_frames=True) as reader:
            text = reader.read().decode("utf-8")
            lines: Iterable[str] = text.splitlines()
            for number, line in enumerate(lines, 1):
                if line.strip():
                    yield _json_line(path, number, line)
        return

    with path.open("r", encoding="utf-8") as source:
        for number, line in enumerate(source, 1):
            if line.strip():
                yield _json_line(path, number, line)


def _json_line(path: Path, number: int, line: str) -> dict[str, Any]:
    try:
        value = json.loads(line)
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid JSON in {path} line {number}: {exc}") from exc
    if not isinstance(value, dict):
        raise ValueError(f"expected an object in {path} line {number}")
    return value


def _content_text(message: Any) -> str:
    if not isinstance(message, dict):
        return ""
    content = message.get("content")
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for block in content:
        if isinstance(block, dict) and isinstance(block.get("text"), str):
            parts.append(block["text"])
    return "\n".join(parts)


def _usage(data: dict[str, Any]) -> tuple[int | None, int | None, int | None, int | None, int | None, int | None]:
    usage = data.get("usage")
    if not isinstance(usage, dict):
        return None, None, None, None, None, None
    input_tokens = usage.get("inputTokens", usage.get("input_tokens"))
    output_tokens = usage.get("outputTokens", usage.get("output_tokens"))
    cache_read = usage.get("cacheReadTokens", usage.get("cache_read_tokens"))
    cache_write = usage.get("cacheWriteTokens", usage.get("cache_write_tokens"))
    reasoning = usage.get("reasoningTokens", usage.get("reasoning_tokens"))
    total = usage.get("totalTokens", usage.get("total_tokens"))
    counted = [value for value in (input_tokens, output_tokens, cache_read, cache_write) if isinstance(value, int)]
    if not isinstance(total, int) and isinstance(input_tokens, int) and isinstance(output_tokens, int):
        total = sum(counted)
    return (
        input_tokens if isinstance(input_tokens, int) else None,
        output_tokens if isinstance(output_tokens, int) else None,
        cache_read if isinstance(cache_read, int) else None,
        cache_write if isinstance(cache_write, int) else None,
        reasoning if isinstance(reasoning, int) else None,
        total if isinstance(total, int) else None,
    )


def _summary(event_type: str, data: dict[str, Any]) -> str:
    if event_type == "tool/call":
        return f"Call {data.get('name', 'tool')}"
    if event_type == "tool/result":
        message = data.get("message")
        text = _content_text(message)
        return ("Error: " if isinstance(message, dict) and message.get("isError") else "Result: ") + text[:160]
    if event_type.endswith("/message"):
        return _content_text(data.get("message"))[:160]
    if event_type == "assistant/attempt":
        return "Assistant attempt (no committed message)"
    return event_type


@dataclass(frozen=True)
class SessionData:
    """Decoded header, events, timeline rows, tool calls, and aggregate metrics."""

    path: Path
    header: dict[str, Any]
    events: list[dict[str, Any]]
    timeline: list[dict[str, Any]]
    tool_calls: list[dict[str, Any]]
    summary: dict[str, Any]

    def to_polars(self, table: str = "timeline") -> Any:
        """Return a Polars DataFrame when polars is installed."""
        try:
            import polars as pl
        except ImportError as exc:
            raise RuntimeError("Install polars in the notebook environment to use to_polars()") from exc
        tables = {"timeline": self.timeline, "tool_calls": self.tool_calls}
        if table not in tables:
            raise ValueError("table must be 'timeline' or 'tool_calls'")
        return pl.DataFrame(tables[table])

    def explain_plan(self, plan_index: int = -1) -> Any:
        """Explain one durable ``exit_plan_mode`` submission and later execution."""
        from .plan import explain_plan

        return explain_plan(self, plan_index)


def load_session(path: str | Path) -> SessionData:
    """Load one ``session.vN.jsonl[.zstd]`` file without changing it."""
    source = Path(path).expanduser().resolve(strict=True)
    records = list(_records(source))
    if not records:
        raise ValueError(f"empty DSH session: {source}")

    first = records[0]
    if "type" in first and "seq" in first:
        header: dict[str, Any] = {}
        events = records
    else:
        header = first
        events = records[1:]

    calls: dict[str, dict[str, Any]] = {}
    tool_calls: list[dict[str, Any]] = []
    timeline: list[dict[str, Any]] = []
    retries = 0
    total_tokens = 0

    for event in events:
        event_type = str(event.get("type", "unknown"))
        data = event.get("data") if isinstance(event.get("data"), dict) else {}
        timestamp = event.get("time")
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, tokens = _usage(data)
        if tokens is not None:
            total_tokens += tokens
        if event_type == "assistant/attempt":
            retries += 1

        call_id: str | None = None
        tool_name: str | None = None
        is_error: bool | None = None
        duration_ms: int | None = None
        if event_type == "tool/call":
            call_id = data.get("callId") if isinstance(data.get("callId"), str) else None
            tool_name = data.get("name") if isinstance(data.get("name"), str) else None
            call = {
                "call_id": call_id,
                "tool_name": tool_name,
                "arguments": data.get("arguments"),
                "start_seq": event.get("seq"),
                "start_time": timestamp,
                "end_seq": None,
                "end_time": None,
                "duration_ms": None,
                "is_error": None,
                "error_code": None,
            }
            if call_id is not None:
                calls[call_id] = call
            tool_calls.append(call)
        elif event_type == "tool/result":
            message = data.get("message") if isinstance(data.get("message"), dict) else {}
            call_id = message.get("toolCallId", message.get("callId"))
            call_id = call_id if isinstance(call_id, str) else None
            is_error = bool(message.get("isError", False))
            call = calls.get(call_id or "")
            if call is not None:
                call["end_seq"] = event.get("seq")
                call["end_time"] = timestamp
                call["is_error"] = is_error
                error = data.get("error")
                call["error_code"] = error.get("code") if isinstance(error, dict) else None
                if isinstance(timestamp, int) and isinstance(call["start_time"], int):
                    duration_ms = timestamp - call["start_time"]
                    call["duration_ms"] = duration_ms
                tool_name = call["tool_name"]

        timeline.append({
            "seq": event.get("seq"),
            "time_ms": timestamp,
            "time_iso": datetime.fromtimestamp(timestamp / 1000, tz=timezone.utc).isoformat() if isinstance(timestamp, int) else None,
            "type": event_type,
            "turn": data.get("turn"),
            "step": data.get("step"),
            "tool_name": tool_name,
            "call_id": call_id,
            "duration_ms": duration_ms,
            "is_error": is_error,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "cache_read_tokens": cache_read_tokens,
            "cache_write_tokens": cache_write_tokens,
            "reasoning_tokens": reasoning_tokens,
            "total_tokens": tokens,
            "summary": _summary(event_type, data),
        })

    failed_calls = sum(call.get("is_error") is True for call in tool_calls)
    summary = {
        "events": len(events),
        "turns": len({row["turn"] for row in timeline if isinstance(row["turn"], int)}),
        "tool_calls": len(tool_calls),
        "failed_tool_calls": failed_calls,
        "assistant_attempts_without_message": retries,
        "total_tokens": total_tokens,
        "started_at_ms": min((row["time_ms"] for row in timeline if isinstance(row["time_ms"], int)), default=None),
        "ended_at_ms": max((row["time_ms"] for row in timeline if isinstance(row["time_ms"], int)), default=None),
    }
    return SessionData(source, header, events, timeline, tool_calls, summary)
