"""Pure, testable loaders behind the locked-console report viewer."""

from __future__ import annotations

import html as _html
import json
import os
import re
from html.parser import HTMLParser
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


def state_root() -> Path:
    return Path(os.environ.get("DSH_VIZTOOLS_STATE_ROOT", ".dsh/viztools/state"))


# The export runs scripts; without allow-same-origin the frame gets an opaque origin, so the
# report can render but cannot reach the marimo or DSH origins. A fixed CSS height avoids
# marimo's mo.iframe auto-resize (onload="__resizeIframe(this)"), which collapsed the frame
# to ~85 px inside the sidebar.
REPORT_FRAME_SANDBOX = "allow-scripts allow-popups allow-downloads"
REPORT_FRAME_HEIGHT = "80vh"


# The export is a marimo app. In the sandboxed (opaque-origin) frame, touching
# localStorage / sessionStorage / indexedDB throws SecurityError. Chromium tolerates it;
# Firefox lands in marimo's error boundary ("Something went wrong — The operation is
# insecure"), notably after the sidebar tab reloads. This shim runs first in <head> and gives
# the page in-memory Storage objects (and no indexedDB when it throws) WITHOUT weakening the
# sandbox: no allow-same-origin, nothing persists, nothing reaches the DSH or marimo origins.
STORAGE_SHIM = """<script data-viztools-storage-shim="1">(function () {
  function MemoryStorage() { this._d = Object.create(null); }
  MemoryStorage.prototype = {
    get length() { return Object.keys(this._d).length; },
    key: function (i) { var k = Object.keys(this._d); return i >= 0 && i < k.length ? k[i] : null; },
    getItem: function (k) { k = String(k); return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; },
    setItem: function (k, v) { this._d[String(k)] = String(v); },
    removeItem: function (k) { delete this._d[String(k)]; },
    clear: function () { this._d = Object.create(null); }
  };
  ["localStorage", "sessionStorage"].forEach(function (name) {
    try { Object.defineProperty(window, name, { value: new MemoryStorage(), configurable: true, enumerable: true, writable: false }); } catch (e) {}
  });
  try {
    var probe = window.indexedDB && window.indexedDB.open("__viztools_probe__");
    if (probe) { probe.onerror = function (event) { if (event && event.preventDefault) event.preventDefault(); }; }
  } catch (e) {
    try { Object.defineProperty(window, "indexedDB", { value: undefined, configurable: true, enumerable: true }); } catch (e2) {}
  }
})();</script>"""

class _HeadLocator(HTMLParser):
    """Find the REAL <head>/<html> start tags. html.parser already treats comments, the
    contents of <script>/<style>, and attribute values as non-markup, so a "<head>" that
    appears inside them is never matched."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=False)
        self.head: tuple[int, int, int] | None = None
        self.html: tuple[int, int, int] | None = None
        self.body_started = False

    def _mark(self) -> tuple[int, int, int]:
        line, column = self.getpos()
        return line, column, len(self.get_starttag_text() or "")

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "html" and self.html is None:
            self.html = self._mark()
        elif tag == "head" and self.head is None and not self.body_started:
            self.head = self._mark()
        elif tag == "body":
            self.body_started = True


def _offset(document: str, line: int, column: int) -> int:
    # html.parser counts lines by "\n" only (unlike str.splitlines), so do the same.
    at = 0
    for _ in range(line - 1):
        at = document.index("\n", at) + 1
    return at + column


def with_storage_shim(document: str) -> str:
    """Insert the storage shim as the first element of the document's real <head>."""
    locator = _HeadLocator()
    try:
        locator.feed(document)
        locator.close()
    except Exception:  # noqa: BLE001 - malformed markup: fall back to a fresh head below
        locator.head = None
    if locator.head is not None:
        line, column, length = locator.head
        at = _offset(document, line, column) + length
        return document[:at] + STORAGE_SHIM + document[at:]
    if locator.html is not None:
        line, column, length = locator.html
        at = _offset(document, line, column) + length
        return document[:at] + "<head>" + STORAGE_SHIM + "</head>" + document[at:]
    return "<head>" + STORAGE_SHIM + "</head>" + document


def report_frame(document: str) -> str:
    """HTML for an iframe that embeds the export at a fixed viewport-relative height."""
    return (
        f'<iframe data-viztools-report="1" title="Run report" sandbox="{REPORT_FRAME_SANDBOX}" '
        f'referrerpolicy="no-referrer" style="width:100%;height:{REPORT_FRAME_HEIGHT};min-height:480px;border:0;display:block" '
        f'srcdoc="{_html.escape(with_storage_shim(document), quote=True)}"></iframe>'
    )


def load_gate_status(session: str, root: Path | None = None) -> list[str]:
    """User-facing gate notices for a session (plan mode unavailable, damaged state, ...)."""
    if not session or not is_safe_session_id(session):
        return []
    base = (root if root is not None else state_root()).resolve()
    target = (base / f"{session}.status.json").resolve()
    if target.parent != base:
        return []
    try:
        status = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    if not isinstance(status, dict) or status.get("sessionId") != session:
        return []
    return [str(status[key]) for key in ("stateBroken", "planNotice", "stateNotice", "countsUntrusted", "rulesInvalid") if isinstance(status.get(key), str) and status.get(key)]


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
