"""Read dsh-viztools gate/report state for reports and the locked viewer.

State lives outside the DSH session log on DSH 0.2.0-rc.2 (plugin sidecar JSONL), in
``plugin:dsh-viztools/<channel>`` records on DSH >= 0.2.1, or — for sessions written by
dsh-viztools <= ca3b3ca — as legacy ``viztools-*`` events in the log itself. All three are
normalized to records ``{"kind", "data", "t"}`` with the gate's record vocabulary.
"""

from __future__ import annotations

import datetime as _dt
import json
from pathlib import Path
from typing import Any

GATE_RECORD_TYPE = "plugin:dsh-viztools/gate"
REPORT_RECORD_TYPE = "plugin:dsh-viztools/report"


def read_sidecar(path: str | Path | None) -> list[dict[str, Any]] | None:
    """Return the readable records of a sidecar file, or ``None`` when it does not exist."""
    if path is None:
        return None
    file = Path(path)
    if not file.is_file():
        return None
    records: list[dict[str, Any]] = []
    for line in file.read_text(encoding="utf-8").splitlines():
        try:
            value = json.loads(line)
        except ValueError:
            continue
        if isinstance(value, dict) and isinstance(value.get("kind"), str) and isinstance(value.get("data"), dict):
            records.append(value)
    return records


def _legacy(event: dict[str, Any]) -> dict[str, Any] | None:
    data = event.get("data") if isinstance(event.get("data"), dict) else {}
    t = event.get("time", 0)
    kind = data.get("kind")
    if event.get("type") == "viztools-gate/change":
        if kind == "approved":
            return {"kind": "plan-approved", "data": {"planCallId": data.get("planCallId")}, "t": t}
        if kind == "refused":
            return {"kind": "refused", "data": {**data, "code": "PLAN_NOT_APPROVED", "beforeApproval": True}, "t": t}
    if event.get("type") == "viztools-run-rules/change":
        if kind == "approved" and isinstance(data.get("rules"), dict):
            rules = dict(data["rules"])
            if data.get("version") == 2 and rules.get("allow") == []:
                rules.pop("allow")
            return {"kind": "rules-approved", "data": {"callId": data.get("callId"), "rules": rules}, "t": t}
        if kind in {"accepted-call", "started-call"}:
            return {"kind": "started", "data": {"callId": data.get("callId"), "tool": data.get("tool")}, "t": t}
        if kind in {"refused-call", "limit-reached"}:
            code = "RUN_RULE_LIMIT" if kind == "limit-reached" else "RUN_RULE_DENIED"
            return {"kind": "refused", "data": {**data, "code": code, "beforeApproval": False}, "t": t}
    return None


def gate_records(session: Any, gate_path: str | Path | None = None) -> list[dict[str, Any]]:
    """Gate records for one session: sidecar, then plugin records, then legacy in-log events."""
    sidecar = read_sidecar(gate_path if gate_path is not None else getattr(session, "plugin_gate_path", None))
    if sidecar is not None:
        return sidecar
    records = [event["data"] for event in session.events if event.get("type") == GATE_RECORD_TYPE and isinstance(event.get("data"), dict)]
    if records:
        return records
    return [record for event in session.events if (record := _legacy(event)) is not None]


def attach_plugin_state(session: Any, plugin_state: dict[str, Any] | None) -> Any:
    """Remember where this session's plugin state lives (from report ``inputs.json``)."""
    if isinstance(plugin_state, dict):
        # SessionData is a frozen dataclass; these are side annotations, not loaded data.
        object.__setattr__(session, "plugin_gate_path", plugin_state.get("gate"))
        object.__setattr__(session, "plugin_status_path", plugin_state.get("status"))
    return session


def _iso(ms: Any) -> str | None:
    if not isinstance(ms, (int, float)) or ms <= 0:
        return None
    return _dt.datetime.fromtimestamp(ms / 1000, tz=_dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def plan_approval(session: Any) -> dict[str, Any]:
    """The approved plan's text and approval time (or the latest submitted plan, unapproved)."""
    from .plan import extract_plans

    records = gate_records(session)
    approvals = [record for record in records if record.get("kind") == "plan-approved"]
    plans = extract_plans(session)
    approved = approvals[-1] if approvals else None
    call_id = approved["data"].get("planCallId") if approved else None
    plan = next((item for item in plans if item["call_id"] == call_id), plans[-1] if plans else None)
    return {
        "approved": approved is not None,
        "approved_at": _iso(approved.get("t")) if approved else None,
        "title": plan["title"] if plan else None,
        "markdown": plan["markdown"] if plan else None,
        "plan_call_id": call_id,
    }


def _merge(previous: dict[str, Any] | None, proposed: dict[str, Any]) -> dict[str, Any]:
    if previous is None:
        return {key: proposed.get(key) for key in ("allow", "deny", "limits") if key in proposed}
    merged: dict[str, Any] = {
        "deny": sorted(set(previous.get("deny", [])) | set(proposed.get("deny", []))),
        "limits": dict(previous.get("limits", {})),
    }
    for tool, limit in proposed.get("limits", {}).items():
        merged["limits"][tool] = min(limit, merged["limits"].get(tool, limit))
    if "allow" in previous and "allow" in proposed:
        merged["allow"] = sorted(set(previous["allow"]) & set(proposed["allow"]))
    elif "allow" in previous or "allow" in proposed:
        merged["allow"] = sorted(previous.get("allow", proposed.get("allow", [])))
    return merged


def effective_rules(records: list[dict[str, Any]]) -> dict[str, Any] | None:
    rules: dict[str, Any] | None = None
    for record in records:
        kind = record.get("kind")
        if kind == "rules-approved" and isinstance(record["data"].get("rules"), dict):
            rules = _merge(rules, record["data"]["rules"])
        elif kind == "rules-invalidated":
            rules = {"allow": [], "deny": [], "limits": {}, "invalid": record["data"].get("reason")}
    return rules


def _short(tool: str) -> str:
    parts = tool.split("__")
    return f"{parts[1]}/{'__'.join(parts[2:])}" if len(parts) >= 3 and parts[0] == "mcp" else tool


def rules_vs_outcome(session: Any) -> list[dict[str, Any]]:
    """Per tool: what the rules allowed/denied/limited vs what started and what was refused."""
    records = gate_records(session)
    rules = effective_rules(records)
    started: dict[str, int] = {}
    started_ids: set[Any] = set()
    refused_before: dict[str, int] = {}
    refused_after: dict[str, int] = {}
    codes: dict[str, set[str]] = {}
    for record in records:
        data = record["data"]
        tool = data.get("tool")
        if not isinstance(tool, str):
            continue
        call_id = data.get("callId")
        if record["kind"] == "started" and call_id not in started_ids:
            started_ids.add(call_id)
            started[tool] = started.get(tool, 0) + 1
        elif record["kind"] == "not-started" and call_id in started_ids:
            started_ids.discard(call_id)
            started[tool] = started.get(tool, 0) - 1
        elif record["kind"] == "refused":
            bucket = refused_before if data.get("beforeApproval") else refused_after
            bucket[tool] = bucket.get(tool, 0) + 1
            codes.setdefault(tool, set()).add(str(data.get("code", "")))
    tools = set(started) | set(refused_before) | set(refused_after)
    if rules is not None:
        tools |= set(rules.get("allow") or []) | set(rules.get("deny", [])) | set(rules.get("limits", {}))
    rows = []
    for tool in sorted(tools):
        if rules is not None and rules.get("invalid"):
            rule = "refused (saved rules invalid)"
        elif rules is not None and tool in rules.get("deny", []):
            rule = "denied"
        elif rules is not None and rules.get("allow") is not None and tool not in rules["allow"]:
            rule = "not in allowlist"
        elif "DEPLOYMENT_TOOL_DENIED" in codes.get(tool, set()):
            rule = "deployment denied"
        else:
            rule = "allowed"
        limit = (rules or {}).get("limits", {}).get(tool)
        count = started.get(tool, 0)
        rows.append({
            "tool": _short(tool),
            "rule": rule,
            "limit": limit,
            "started": count,
            "refused before approval": refused_before.get(tool, 0),
            "refused after approval": refused_after.get(tool, 0),
            "result": ("limit reached" if limit is not None and count >= limit else "within rules") if rule == "allowed" else ("blocked" if count == 0 else "VIOLATION: started while not allowed"),
        })
    return rows


def compact_tool_rows(session: Any) -> list[dict[str, Any]]:
    """Narrow tool table for the sidebar: no argument column (arguments are shown separately)."""
    rows = []
    for index, call in enumerate(getattr(session, "tool_calls", []), start=1):
        rows.append({
            "#": index,
            "tool": _short(str(call.get("tool_name") or "")),
            "status": "error" if call.get("is_error") else "ok",
            "ms": call.get("duration_ms"),
        })
    return rows
