"""Pure, testable loaders behind the locked-console report viewer."""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

SESSION_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
MAX_REPORT_BYTES = 64 * 1024 * 1024
REPORT_ROUTE = "/api/viztools/report"


def is_safe_session_id(value: str) -> bool:
    return bool(SESSION_ID.fullmatch(value)) and ".." not in value


def report_root() -> Path:
    return Path(os.environ.get("DSH_VIZTOOLS_REPORT_ROOT", ".dsh/reports"))


def _pending(session: str) -> dict[str, Any]:
    return {"status": "pending", "session": session, "html": "", "reason": ""}


def _invalid(session: str, reason: str) -> dict[str, Any]:
    return {"status": "invalid", "session": session, "html": "", "reason": reason}


def load_view_state(session: str, root: Path | None = None) -> dict[str, Any]:
    """Return the view model for one session without ever leaving its report directory."""
    if not session:
        return _pending("")
    if not is_safe_session_id(session):
        return _invalid("", "The requested session id is not valid.")
    base = (root if root is not None else report_root()).resolve()
    session_dir = (base / session).resolve()
    if session_dir.parent != base:
        return _invalid(session, "The session report directory resolves outside the report root.")
    try:
        state = json.loads((session_dir / "state.json").read_text(encoding="utf-8"))
    except FileNotFoundError:
        return _pending(session)
    except (OSError, ValueError):
        return _invalid(session, "The report state could not be read.")
    if not isinstance(state, dict) or state.get("sessionId") != session:
        return _invalid(session, "The report state does not belong to this session.")
    status = state.get("status")
    if status == "failed":
        return {"status": "failed", "session": session, "html": "", "reason": str(state.get("reason", "Unknown failure"))}
    if status != "available":
        return _pending(session)
    try:
        target = Path(str(state.get("html", ""))).resolve(strict=True)
    except (OSError, RuntimeError):
        return _invalid(session, "The report file is missing.")
    if target != session_dir / "report.html":
        return _invalid(session, "The report file resolves outside this session's report directory.")
    if target.stat().st_size > MAX_REPORT_BYTES:
        return _invalid(session, "The report is too large to display.")
    return {"status": "available", "session": session, "html": target.read_text(encoding="utf-8"), "reason": ""}


def safe_report_url(value: str) -> str:
    """Accept only an http(s) URL pointing at the authenticated DSH report route."""
    if not value:
        return ""
    try:
        parts = urlsplit(value)
    except ValueError:
        return ""
    if parts.scheme not in {"http", "https"} or not parts.netloc or parts.path != REPORT_ROUTE or parts.fragment:
        return ""
    return value
