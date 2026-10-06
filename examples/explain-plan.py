import marimo

__generated_with = "0.25.1"
app = marimo.App(width="full")


@app.cell
def _():
    import marimo as mo
    from pathlib import Path
    from dsh_viztools.session import load_session
    return Path, load_session, mo


@app.cell
def _(Path, mo):
    session_path = mo.ui.text(
        value=str(Path.home() / ".dsh/sessions/<workspace>/<session>/session.v4.jsonl.zstd"),
        label="DSH trajectory containing an exit_plan_mode submission",
        full_width=True,
    )
    session_path
    return (session_path,)


@app.cell
def _(load_session, session_path):
    run = load_session(session_path.value)
    explanation = run.explain_plan()
    return explanation, run


@app.cell
def _(explanation, mo):
    summary = explanation.summary
    servers = ", ".join(summary["mcp_servers"]) or "none"
    mo.md(
        f"""
        # Plan execution report: {explanation.plan['title']}

        The trajectory records **{summary['execution_calls']:,} post-submission tool calls**:
        **{summary['native_calls']:,} native** and **{summary['mcp_calls']:,} MCP** calls.
        **{summary['failed_calls']:,}** calls failed. Observed MCP servers: **{servers}**.

        Attribution warning: call existence, ordering, results, and timing are direct log evidence.
        Associations between calls and plan phases are keyword-based heuristics.
        """
    )
    return (summary,)


@app.cell
def _(explanation, mo):
    mo.md("## Submitted plan\nThis is the exact Markdown carried by `exit_plan_mode`.")
    mo.md(explanation.plan["markdown"])
    return


@app.cell
def _(explanation, mo):
    phase_rows = [
        {
            "Phase": phase["title"],
            "Level": phase["level"],
            "Keywords used for attribution": ", ".join(phase["keywords"]),
        }
        for phase in explanation.phases
    ]
    mo.md("## Plan phases\nThese headings form the candidate execution phases.")
    mo.ui.table(phase_rows, pagination=True, page_size=20, selection=None)
    return (phase_rows,)


@app.cell
def _(explanation, mo):
    mo.md("## Tool inventory\nMCP identities are parsed from `mcp__<server>__<tool>` names.")
    mo.ui.table(explanation.tool_inventory, pagination=True, page_size=20, selection=None)
    return


@app.cell
def _(explanation, mo):
    mo.md("## MCP operations\nThis table separates each observed MCP server and operation.")
    mo.ui.table(explanation.mcp_inventory, pagination=True, page_size=20, selection=None)
    return


@app.cell
def _(explanation, mo):
    execution_rows = [
        {
            "Seq": call["start_seq"],
            "Transport": call["transport"],
            "Tool": call["tool_name"],
            "Kind": call["tool_kind"],
            "MCP server": call["mcp_server"],
            "Phase": call["phase"],
            "Attribution": call["attribution"],
            "Matched terms": ", ".join(call["matched_keywords"]),
            "Duration ms": call["duration_ms"],
            "Failed": call["is_error"],
            "Error code": call["error_code"],
        }
        for call in explanation.calls
    ]
    mo.md(
        "## Execution evidence\n"
        "`heuristic` means keyword overlap with a plan phase; `not-observed` means the call is durable but no phase attribution is supported."
    )
    mo.ui.table(execution_rows, pagination=True, page_size=25, selection=None)
    return (execution_rows,)


@app.cell
def _(explanation, mo, summary):
    phases_with_calls = {call["phase_index"] for call in explanation.calls if call["phase_index"] is not None}
    phases_without_mapped_calls = [
        phase["title"] for phase in explanation.phases if phase["index"] not in phases_with_calls
    ]
    mo.md(
        f"""
        ## Variance and evidence notes

        - **{summary['heuristically_mapped_calls']:,}** calls have heuristic phase attribution.
        - **{summary['unmapped_calls']:,}** calls remain unmapped; they may be unplanned work or simply lack enough textual evidence.
        - Phases without a mapped tool call: **{', '.join(phases_without_mapped_calls) or 'none'}**.

        A phase without a mapped tool call is **not automatically skipped**: analysis, discussion,
        or other prose-only work may leave no tool-call evidence.
        """
    )
    return (phases_without_mapped_calls,)


if __name__ == "__main__":
    app.run()
