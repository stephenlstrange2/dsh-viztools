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
        label="DSH trajectory",
        full_width=True,
    )
    plan_source = mo.ui.dropdown(
        options={
            "Use durable exit_plan_mode plan": "submitted",
            "Use plan text below": "user-provided",
            "Use reconstructed plan text below": "reconstructed",
        },
        value="submitted",
        label="Plan source",
    )
    plan_text = mo.ui.text_area(
        value="",
        label="Optional plan Markdown (start with # heading)",
        full_width=True,
        rows=10,
    )
    boundary_seq = mo.ui.number(
        value=None,
        start=0,
        label="Optional execution boundary sequence",
    )
    mo.vstack([session_path, plan_source, plan_text, boundary_seq])
    return boundary_seq, plan_source, plan_text, session_path


@app.cell
def _(boundary_seq, load_session, plan_source, plan_text, session_path):
    run = load_session(session_path.value)
    use_text = plan_source.value != "submitted" and bool(plan_text.value.strip())
    explanation = run.explain_plan(
        plan_markdown=plan_text.value if use_text else None,
        source=plan_source.value if use_text else "user-provided",
        boundary_seq=int(boundary_seq.value) if boundary_seq.value is not None else None,
    )
    return explanation, run


@app.cell
def _(explanation, mo):
    summary = explanation.summary
    servers = ", ".join(summary["mcp_servers"]) or "none"
    source_labels = {
        "submitted": "Submitted DSH plan",
        "user-provided": "User-provided plan; approval not observed",
        "reconstructed": "Reconstructed plan; not an approved plan",
        "not-observed": "No plan observed — execution evidence only",
    }
    comparison = "available" if summary["comparison_available"] else "unavailable until a plan is provided"
    mo.md(
        f"""
        # Plan execution report: {explanation.plan['title']}

        **Plan source:** {source_labels[summary['plan_source']]}

        **Comparison:** {comparison}

        **Execution boundary:** {summary['boundary']} (sequence {summary['boundary_seq']})

        The trajectory records **{summary['execution_calls']:,} tool calls** after the selected boundary:
        **{summary['native_calls']:,} native** and **{summary['mcp_calls']:,} MCP** calls.
        **{summary['failed_calls']:,}** calls failed. Observed MCP servers: **{servers}**.

        Call existence, ordering, results, and timing are direct log evidence.
        Associations between calls and plan phases are keyword-based heuristics.
        """
    )
    return (summary,)


@app.cell
def _(explanation, mo):
    if explanation.plan["markdown"] is None:
        plan_view = mo.md(
            "## Plan comparison unavailable\nNo durable `exit_plan_mode` submission was observed. "
            "The execution inventory below remains valid. Select a provided or reconstructed plan above to enable comparison."
        )
    else:
        plan_view = mo.vstack([
            mo.md("## Comparison plan\nThe source and approval status are shown above."),
            mo.md(explanation.plan["markdown"]),
        ])
    plan_view
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
    mo.md("## Plan phases\nEmpty when no comparison plan is available.")
    mo.ui.table(phase_rows, pagination=True, page_size=20, selection=None)
    return (phase_rows,)


@app.cell
def _(explanation, mo):
    mo.md("## Tool inventory\nMCP identities are parsed from `mcp__<server>__<tool>` names.")
    mo.ui.table(explanation.tool_inventory, pagination=True, page_size=20, selection=None)
    return


@app.cell
def _(explanation, mo):
    mo.md("## MCP operations\nThis remains useful even when no comparison plan exists.")
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
    mo.md("## Execution evidence\nUnmapped calls remain visible rather than being discarded.")
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
        - **{summary['unmapped_calls']:,}** calls remain unmapped.
        - Phases without a mapped call: **{', '.join(phases_without_mapped_calls) or 'none'}**.

        Unmapped calls may be unplanned or insufficiently attributable. A phase without a mapped
        tool call is not automatically skipped: prose-only work may leave no tool evidence.
        """
    )
    return (phases_without_mapped_calls,)


if __name__ == "__main__":
    app.run()
