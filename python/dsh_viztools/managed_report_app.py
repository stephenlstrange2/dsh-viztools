"""Stable trusted marimo app for locked-console report presentation.

The app only ever reads ``<DSH_VIZTOOLS_REPORT_ROOT>/<session>/state.json`` and the
``report.html`` it names. The session id comes from the browser query string, so it is
validated as a single safe path segment before any filesystem access, and every resolved
path must stay inside that session's directory.
"""

import marimo

__generated_with = "0.25.1"
app = marimo.App(width="full")


@app.cell
def _():
    import marimo as mo
    from dsh_viztools.managed_view import load_view_state, safe_report_url

    return load_view_state, mo, safe_report_url


@app.cell
def _(mo):
    # Auto-poll while waiting; a manual button checks for a newer report later.
    auto_refresh = mo.ui.refresh(default_interval="2s")
    manual_refresh = mo.ui.refresh(label="Check for a newer report")
    return auto_refresh, manual_refresh


@app.cell
def _(auto_refresh, load_view_state, manual_refresh, mo, safe_report_url):
    auto_refresh.value, manual_refresh.value
    params = mo.query_params()
    view_state = load_view_state(params.get("session", "") or "")
    report_url = safe_report_url(params.get("report_url", "") or "")
    return report_url, view_state


@app.cell
def _(auto_refresh, manual_refresh, mo, report_url, view_state):
    status = view_state["status"]
    session_label = view_state["session"] or "not selected"
    if status == "available":
        header = [mo.md(f"# Run report\n\nSession: `{session_label}`")]
        if report_url:
            header.append(mo.md(f"[Open the report in a new tab]({report_url})"))
        header.append(manual_refresh)
        view = mo.vstack([*header, mo.iframe(view_state["html"], height="85vh")])
    elif status == "failed":
        view = mo.vstack([
            mo.md(f"# Report generation failed\n\nSession: `{session_label}`"),
            mo.plain_text(view_state["reason"]),
            auto_refresh,
        ])
    elif status == "invalid":
        view = mo.md(f"# Report unavailable\n\n{view_state['reason']}")
    else:
        view = mo.vstack([
            mo.md(f"# Plan in progress\n\nSession: `{session_label}`\n\nThe trusted report appears here automatically after the terminal run tool completes."),
            auto_refresh,
        ])
    view
    return


if __name__ == "__main__":
    app.run()
