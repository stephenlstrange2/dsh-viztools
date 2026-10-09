"""Stable trusted marimo app for locked-console report presentation."""

import marimo

__generated_with = "0.25.1"
app = marimo.App(width="full")


@app.cell
def _():
    import json
    import os
    from pathlib import Path
    import marimo as mo
    return Path, json, mo, os


@app.cell
def _(Path, json, mo, os):
    state_root = Path(os.environ.get("DSH_VIZTOOLS_REPORT_ROOT", ".dsh/reports"))
    session_id = mo.query_params().get("session", "")
    if not session_id:
        state = {"status": "pending", "sessionId": "", "updatedAt": 0}
    else:
        state_file = state_root / session_id / "state.json"
        try:
            state = json.loads(state_file.read_text(encoding="utf-8"))
        except FileNotFoundError:
            state = {"status": "pending", "sessionId": session_id, "updatedAt": 0}
    return session_id, state


@app.cell
def _(mo, session_id, state):
    status = state.get("status")
    if status == "available":
        html = state.get("html", "")
        view = mo.vstack([
            mo.md(f"# Run report ready\n\nSession: `{session_id}`"),
            mo.md(f"[Open the generated static report]({html})"),
        ])
    elif status == "failed":
        view = mo.md(f"# Report generation failed\n\nSession: `{session_id}`\n\n{state.get('reason', 'Unknown failure')}")
    else:
        view = mo.md(f"# Plan in progress\n\nSession: `{session_id or 'not selected'}`\n\nThe trusted report will appear after the terminal run tool completes.")
    view
    return


if __name__ == "__main__":
    app.run()
