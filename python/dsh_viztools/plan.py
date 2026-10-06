"""Explain submitted DSH plans with execution and tool evidence.

A submitted plan is durable as the ``plan`` argument of an ``exit_plan_mode``
invocation. This module extracts native and PTC submissions, classifies native
versus MCP tools, and maps later calls to plan sections. Mapping is deliberately
conservative: sequence boundaries are direct evidence; phase attribution is a
keyword heuristic and is labelled as such.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
import json
import re
from typing import Any

from .session import SessionData

_MCP_NAME = re.compile(r"^mcp__([A-Za-z0-9_-]+)__(.+)$")
_HEADING = re.compile(r"^(#{1,6})\s+(\S.*)$")
_TOKEN = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:/-]{2,}")
_STOPWORDS = {
    "about", "after", "against", "also", "before", "build", "change", "complete",
    "create", "from", "have", "implementation", "into", "plan", "should", "that",
    "their", "then", "this", "through", "using", "when", "where", "with", "without",
}


def classify_tool(name: str) -> dict[str, str | None]:
    """Classify a durable DSH tool name as native or MCP."""
    match = _MCP_NAME.match(name)
    if match is None:
        return {"kind": "native", "server": None, "operation": name}
    return {"kind": "mcp", "server": match.group(1), "operation": match.group(2)}


def _arguments(value: Any) -> dict[str, Any] | None:
    if isinstance(value, dict):
        return value
    if not isinstance(value, str):
        return None
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _plan_from_event(event: dict[str, Any]) -> dict[str, Any] | None:
    event_type = event.get("type")
    if event_type not in {"tool/call", "tool/ptc-dispatch-start", "tool/ptc-dispatch"}:
        return None
    data = event.get("data")
    if not isinstance(data, dict) or data.get("name") != "exit_plan_mode":
        return None
    call_id = data.get("callId") if event_type == "tool/call" else data.get("subCallId")
    args = _arguments(data.get("arguments"))
    if not isinstance(call_id, str) or not call_id or args is None:
        return None
    markdown = args.get("plan")
    if not isinstance(markdown, str):
        return None
    title = next((match.group(2) for line in markdown.strip().splitlines() if (match := _HEADING.match(line))), None)
    if title is None:
        return None
    return {
        "call_id": call_id,
        "seq": event.get("seq"),
        "turn": data.get("turn"),
        "step": data.get("step"),
        "title": title,
        "markdown": markdown,
        "transport": "native" if event_type == "tool/call" else "ptc",
    }


def extract_plans(session: SessionData) -> list[dict[str, Any]]:
    """Extract unique submitted plans in durable invocation order."""
    plans: list[dict[str, Any]] = []
    seen: set[str] = set()
    for event in session.events:
        plan = _plan_from_event(event)
        if plan is None or plan["call_id"] in seen:
            continue
        seen.add(plan["call_id"])
        plans.append(plan)
    return plans


def _sections(markdown: str) -> list[dict[str, Any]]:
    sections: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    for line in markdown.splitlines():
        match = _HEADING.match(line)
        if match is not None:
            current = {"index": len(sections), "level": len(match.group(1)), "title": match.group(2), "body": ""}
            sections.append(current)
        elif current is not None:
            current["body"] = f"{current['body']}\n{line}".strip()
    if len(sections) > 1 and sections[0]["level"] == 1:
        sections = sections[1:]
        for index, section in enumerate(sections):
            section["index"] = index
    if not sections:
        sections = [{"index": 0, "level": 1, "title": "Plan", "body": markdown}]
    for section in sections:
        text = f"{section['title']} {section['body']}".lower()
        section["keywords"] = sorted({
            token for token in _TOKEN.findall(text)
            if token not in _STOPWORDS and not token.isdigit()
        })
    return sections


def _tool_rows(session: SessionData) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    starts: dict[str, dict[str, Any]] = {}
    native_calls = {call.get("call_id"): call for call in session.tool_calls if isinstance(call.get("call_id"), str)}

    for event in session.events:
        event_type = event.get("type")
        data = event.get("data") if isinstance(event.get("data"), dict) else {}
        if event_type == "tool/call":
            call_id = data.get("callId")
            name = data.get("name")
            if not isinstance(call_id, str) or not isinstance(name, str):
                continue
            call = native_calls.get(call_id, {})
            classification = classify_tool(name)
            rows.append({
                "call_id": call_id,
                "parent_call_id": None,
                "transport": "native",
                "tool_name": name,
                "tool_kind": classification["kind"],
                "mcp_server": classification["server"],
                "operation": classification["operation"],
                "arguments": data.get("arguments"),
                "start_seq": event.get("seq"),
                "end_seq": call.get("end_seq"),
                "duration_ms": call.get("duration_ms"),
                "is_error": call.get("is_error"),
                "error_code": call.get("error_code"),
            })
        elif event_type == "tool/ptc-dispatch-start":
            sub_id = data.get("subCallId")
            name = data.get("name")
            if isinstance(sub_id, str) and isinstance(name, str):
                starts[sub_id] = {"event": event, "data": data}
        elif event_type == "tool/ptc-dispatch":
            sub_id = data.get("subCallId")
            name = data.get("name")
            if not isinstance(sub_id, str) or not isinstance(name, str):
                continue
            start = starts.get(sub_id)
            start_event = start["event"] if start is not None else event
            start_data = start["data"] if start is not None else data
            start_time = start_event.get("time")
            end_time = event.get("time")
            classification = classify_tool(name)
            error = data.get("error")
            rows.append({
                "call_id": sub_id,
                "parent_call_id": data.get("parentCallId"),
                "transport": "ptc",
                "tool_name": name,
                "tool_kind": classification["kind"],
                "mcp_server": classification["server"],
                "operation": classification["operation"],
                "arguments": start_data.get("arguments"),
                "start_seq": start_event.get("seq"),
                "end_seq": event.get("seq"),
                "duration_ms": end_time - start_time if isinstance(start_time, int) and isinstance(end_time, int) else None,
                "is_error": bool(data.get("isError", False)),
                "error_code": error.get("code") if isinstance(error, dict) else None,
            })
    return sorted(rows, key=lambda row: row["start_seq"] if isinstance(row["start_seq"], int) else -1)


def _evidence_text(row: dict[str, Any]) -> str:
    args = row.get("arguments")
    if isinstance(args, str):
        arg_text = args
    else:
        try:
            arg_text = json.dumps(args, sort_keys=True)
        except TypeError:
            arg_text = str(args)
    return f"{row.get('tool_name', '')} {row.get('operation', '')} {arg_text}".lower()


def _map_phase(row: dict[str, Any], phases: list[dict[str, Any]]) -> tuple[int | None, str, list[str]]:
    evidence = _evidence_text(row)
    evidence_tokens = set(_TOKEN.findall(evidence))
    scored: list[tuple[int, int, list[str]]] = []
    for phase in phases:
        matches = [keyword for keyword in phase["keywords"] if keyword in evidence_tokens]
        if matches:
            scored.append((len(matches), -phase["index"], matches))
    if not scored:
        return None, "not-observed", []
    score, negative_index, matches = max(scored)
    return -negative_index, "heuristic", matches


@dataclass(frozen=True)
class PlanExplanation:
    """Optional plan comparison plus durable execution evidence."""

    plan: dict[str, Any]
    phases: list[dict[str, Any]]
    calls: list[dict[str, Any]]
    tool_inventory: list[dict[str, Any]]
    mcp_inventory: list[dict[str, Any]]
    summary: dict[str, Any]

    def to_polars(self, table: str = "calls") -> Any:
        try:
            import polars as pl
        except ImportError as exc:
            raise RuntimeError("Install polars in the notebook environment to use to_polars()") from exc
        tables = {
            "phases": self.phases,
            "calls": self.calls,
            "tool_inventory": self.tool_inventory,
            "mcp_inventory": self.mcp_inventory,
        }
        if table not in tables:
            raise ValueError(f"table must be one of {', '.join(tables)}")
        return pl.DataFrame(tables[table])


def _title(markdown: str, fallback: str) -> str:
    return next(
        (match.group(2) for line in markdown.strip().splitlines() if (match := _HEADING.match(line))),
        fallback,
    )


def _boundary_seq(session: SessionData, boundary: str, explicit: int | None) -> int | None:
    if explicit is not None:
        if not isinstance(explicit, int) or explicit < 0:
            raise ValueError("boundary_seq must be a non-negative integer")
        return explicit
    if boundary == "session-start":
        return None
    if boundary == "first-user-message":
        return next(
            (event.get("seq") for event in session.events if event.get("type") == "user/message" and isinstance(event.get("seq"), int)),
            None,
        )
    raise ValueError("boundary must be 'session-start' or 'first-user-message'")


def explain_plan(
    session: SessionData,
    plan_index: int = -1,
    *,
    plan_markdown: str | None = None,
    source: str = "user-provided",
    boundary: str = "session-start",
    boundary_seq: int | None = None,
) -> PlanExplanation:
    """Explain submitted/provided plans or gracefully return execution-only evidence."""
    plans = extract_plans(session)
    if plan_markdown is not None:
        if not isinstance(plan_markdown, str) or not plan_markdown.strip():
            raise ValueError("plan_markdown must be a non-empty string")
        if source not in {"user-provided", "reconstructed"}:
            raise ValueError("provided plan source must be 'user-provided' or 'reconstructed'")
        submission_seq = _boundary_seq(session, boundary, boundary_seq)
        plan = {
            "call_id": None,
            "seq": submission_seq,
            "turn": None,
            "step": None,
            "title": _title(plan_markdown, "Provided plan" if source == "user-provided" else "Reconstructed plan"),
            "markdown": plan_markdown,
            "transport": None,
            "source": source,
            "approval": "not-observed",
            "boundary": "explicit-seq" if boundary_seq is not None else boundary,
        }
    elif plans:
        try:
            plan = {**plans[plan_index], "source": "submitted", "approval": "submitted", "boundary": "submission"}
        except IndexError as exc:
            raise IndexError(f"plan_index {plan_index} is outside {len(plans)} submitted plan(s)") from exc
        submission_seq = plan.get("seq")
    else:
        plan = {
            "call_id": None,
            "seq": _boundary_seq(session, boundary, boundary_seq),
            "turn": None,
            "step": None,
            "title": "Execution evidence only",
            "markdown": None,
            "transport": None,
            "source": "not-observed",
            "approval": "not-observed",
            "boundary": "explicit-seq" if boundary_seq is not None else boundary,
        }
        submission_seq = plan["seq"]

    phases = _sections(plan["markdown"]) if isinstance(plan["markdown"], str) else []
    all_calls = _tool_rows(session)
    calls: list[dict[str, Any]] = []
    for row in all_calls:
        start_seq = row.get("start_seq")
        if isinstance(submission_seq, int) and isinstance(start_seq, int) and start_seq <= submission_seq:
            continue
        phase_index, confidence, matches = _map_phase(row, phases) if phases else (None, "not-observed", [])
        phase = phases[phase_index] if phase_index is not None else None
        calls.append({
            **row,
            "phase_index": phase_index,
            "phase": phase["title"] if phase is not None else "Unmapped execution",
            "attribution": confidence,
            "matched_keywords": matches,
            "evidence": "direct" if isinstance(row.get("start_seq"), int) else "not-observed",
        })

    inventory_counter = Counter((row["tool_name"], row["tool_kind"], row["mcp_server"], row["operation"]) for row in calls)
    failure_counter = Counter(row["tool_name"] for row in calls if row.get("is_error") is True)
    tool_inventory = [
        {
            "tool_name": name,
            "tool_kind": kind,
            "mcp_server": server,
            "operation": operation,
            "calls": count,
            "failures": failure_counter[name],
        }
        for (name, kind, server, operation), count in inventory_counter.most_common()
    ]
    mcp_counter = Counter((row["mcp_server"], row["operation"]) for row in calls if row["tool_kind"] == "mcp")
    mcp_inventory = [
        {"server": server, "operation": operation, "calls": count}
        for (server, operation), count in mcp_counter.most_common()
    ]
    mapped = sum(row["attribution"] == "heuristic" for row in calls)
    summary = {
        "submitted_plans": len(plans),
        "selected_plan_index": (plan_index if plan_index >= 0 else len(plans) + plan_index) if plan["source"] == "submitted" else None,
        "plan_source": plan["source"],
        "approval": plan["approval"],
        "comparison_available": bool(phases),
        "boundary": plan["boundary"],
        "boundary_seq": submission_seq,
        "phases": len(phases),
        "execution_calls": len(calls),
        "native_calls": sum(row["tool_kind"] == "native" for row in calls),
        "mcp_calls": sum(row["tool_kind"] == "mcp" for row in calls),
        "failed_calls": sum(row.get("is_error") is True for row in calls),
        "heuristically_mapped_calls": mapped,
        "unmapped_calls": len(calls) - mapped,
        "mcp_servers": sorted({row["mcp_server"] for row in calls if row["mcp_server"] is not None}),
    }
    return PlanExplanation(plan, phases, calls, tool_inventory, mcp_inventory, summary)
