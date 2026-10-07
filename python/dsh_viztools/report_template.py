"""Default managed report template instantiated by dsh-viztools/report."""

import marimo

__generated_with = "0.25.1"
app = marimo.App(width="full")


@app.cell
def _():
    import json
    from pathlib import Path
    import marimo as mo
    from dsh_viztools.session import load_session
    inputs = json.loads(Path(__file__).with_name("inputs.json").read_text(encoding="utf-8"))
    run = load_session(inputs["trajectory"])
    return inputs, mo, run


@app.cell
def _(inputs, mo, run):
    stats = run.summary
    mo.md(f"""
    # DSH session report

    **Session:** `{inputs['sessionId']}`  
    **Trigger:** `{inputs['trigger']}` at sequence **{inputs['triggerSeq']}**

    - **{stats['events']:,}** durable events
    - **{stats['turns']:,}** turns
    - **{stats['tool_calls']:,}** tool calls
    - **{stats['failed_tool_calls']:,}** failed tool calls
    - **{stats['total_tokens']:,}** reported tokens
    """)
    return


@app.cell
def _(mo, run):
    mo.md("## Tool calls\nDurable calls paired with their recorded outcomes.")
    mo.ui.table(run.tool_calls, pagination=True, page_size=20, selection=None)
    return


@app.cell
def _(mo, run):
    explanation = run.explain_plan()
    mo.md("## Plan and run rules\nComparison is shown when a plan or approved rules are present.")
    mo.ui.table(explanation.rules, pagination=True, page_size=20, selection=None)
    return (explanation,)


@app.cell
def _(explanation, mo):
    mo.md("## Execution inventory")
    mo.ui.table(explanation.tool_inventory, pagination=True, page_size=20, selection=None)
    return


if __name__ == "__main__":
    app.run()
