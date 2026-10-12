"""Privacy-preserving report projections for durable tool arguments."""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any

_SECRET_KEY = re.compile(r"(?:token|password|secret|api[_-]?key|authorization|cookie)", re.I)
_TOKEN_URL = re.compile(r"([?&](?:access_token|token|key|signature|sig)=)[^&#\s]+", re.I)
_SAFE_FIELDS: dict[str, set[str]] = {
    "read": {"file_path", "offset", "limit"},
    "grep": {"pattern", "path", "include"},
    "glob": {"pattern", "path"},
    "mcp__otx__replay_tx_only": {"run_id", "step"},
    "mcp__otx__diff": {"run_id"},
    "mcp__otx__finalize_run": {"run_id", "verdict"},
}


def _redact_string(value: str, max_string: int) -> str:
    redacted = _TOKEN_URL.sub(r"\1[REDACTED]", value)
    if len(redacted) <= max_string:
        return redacted
    digest = hashlib.sha256(redacted.encode()).hexdigest()
    return f"[OMITTED string {len(redacted.encode())} bytes sha256:{digest}]"


def _bounded(value: Any, max_string: int, depth: int = 0) -> Any:
    if depth > 4:
        raw = json.dumps(value, sort_keys=True, default=str)
        return f"[OMITTED nested {len(raw.encode())} bytes sha256:{hashlib.sha256(raw.encode()).hexdigest()}]"
    if isinstance(value, str):
        return _redact_string(value, max_string)
    if isinstance(value, list):
        return [_bounded(item, max_string, depth + 1) for item in value[:20]] + ([f"[OMITTED {len(value)-20} items]"] if len(value) > 20 else [])
    if isinstance(value, dict):
        return {key: "[REDACTED]" if _SECRET_KEY.search(str(key)) else _bounded(item, max_string, depth + 1) for key, item in list(value.items())[:30]}
    return value


def safe_tool_arguments(tool_name: str, arguments: Any, *, max_bytes: int = 2048, max_string: int = 256) -> Any:
    """Return a bounded projection; unknown tools expose no raw argument fields."""
    if isinstance(arguments, str):
        try:
            parsed = json.loads(arguments)
        except json.JSONDecodeError:
            parsed = arguments
    else:
        parsed = arguments
    allowed = _SAFE_FIELDS.get(tool_name)
    if allowed is None:
        raw = json.dumps(parsed, sort_keys=True, default=str)
        return f"[OMITTED arguments {len(raw.encode())} bytes sha256:{hashlib.sha256(raw.encode()).hexdigest()}]"
    if isinstance(parsed, dict):
        parsed = {key: value for key, value in parsed.items() if key in allowed}
    projected = _bounded(parsed, max_string)
    raw = json.dumps(projected, sort_keys=True, default=str)
    if len(raw.encode()) > max_bytes:
        return f"[OMITTED arguments {len(raw.encode())} bytes sha256:{hashlib.sha256(raw.encode()).hexdigest()}]"
    return projected


def safe_tool_rows(tool_calls: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows = []
    for call in tool_calls:
        rows.append({
            "tool": call.get("tool_name"),
            "arguments": safe_tool_arguments(str(call.get("tool_name") or ""), call.get("arguments")),
            "duration_ms": call.get("duration_ms"),
            "is_error": call.get("is_error"),
            "error_code": call.get("error_code"),
        })
    return rows
