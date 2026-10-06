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
    session_path
    return (session_path,)


@app.cell
def _(load_session, session_path):
    run = load_session(session_path.value)
    return (run,)


@app.cell
def _(mo, run):
    stats = run.summary
    failure_rate = (
        100 * stats["failed_tool_calls"] / stats["tool_calls"]
        if stats["tool_calls"]
        else 0
    )
    mo.md(
        f"""
        # Explain a DSH session

        This report is computed directly from the selected append-only trajectory.

        - **{stats['events']:,}** events across **{stats['turns']:,}** turns
        - **{stats['tool_calls']:,}** tool calls; **{stats['failed_tool_calls']:,}** failed ({failure_rate:.1f}%)
        - **{stats['assistant_attempts_without_message']:,}** assistant attempts without a committed message
        - **{stats['total_tokens']:,}** reported tokens
        """
    )
    return (stats,)


@app.cell
def _(mo, run):
    timeline_rows = [
        {
            "Seq": row["seq"],
            "Time": row["time_iso"],
            "Turn": row["turn"],
            "Step": row["step"],
            "Event": row["type"],
            "Tool": row["tool_name"],
            "Elapsed ms": row["duration_ms"],
            "Summary": row["summary"],
        }
        for row in run.timeline
    ]
    mo.md("## Event timeline\nEvery row links back to one durable event in the session log.")
    mo.ui.table(timeline_rows, pagination=True, page_size=20, selection=None)
    return (timeline_rows,)


@app.cell
def _(mo, run):
    completed_calls = [
        call for call in run.tool_calls if isinstance(call.get("duration_ms"), int)
    ]
    slowest_calls = sorted(
        completed_calls,
        key=lambda call: call["duration_ms"],
        reverse=True,
    )[:20]
    mo.md("## Slowest tool calls\nThis table highlights where wall-clock time accumulated.")
    mo.ui.table(slowest_calls, pagination=True, page_size=20, selection=None)
    return (slowest_calls,)


@app.cell
def _(mo, run):
    token_rows = [
        {
            "Seq": row["seq"],
            "Turn": row["turn"],
            "Input": row["input_tokens"],
            "Cache read": row["cache_read_tokens"],
            "Cache write": row["cache_write_tokens"],
            "Output": row["output_tokens"],
            "Reasoning": row["reasoning_tokens"],
            "Total": row["total_tokens"],
        }
        for row in run.timeline
        if row["total_tokens"] is not None
    ]
    mo.md("## Token usage\nCounts are preserved per model response instead of recomputed from prose.")
    mo.ui.table(token_rows, pagination=True, page_size=20, selection=None)
    return (token_rows,)


@app.cell
def _(mo, run, stats):
    failure_rate = (
        100 * stats["failed_tool_calls"] / stats["tool_calls"]
        if stats["tool_calls"]
        else 0
    )
    mo.md(
        f"""
        ## Executive summary

        The agent made **{stats['tool_calls']:,} tool calls**. Of those,
        **{stats['failed_tool_calls']:,} failed ({failure_rate:.1f}%)**. The log contains
        **{stats['assistant_attempts_without_message']:,} assistant attempt(s) without a committed
        message**, the trajectory's clearest retry or abandoned-attempt signal.
        """
    )
    return


if __name__ == "__main__":
    app.run()
