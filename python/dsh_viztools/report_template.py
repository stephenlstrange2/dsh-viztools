"""Default managed report template instantiated by dsh-viztools/report.

Sections are laid out for the narrow DSH right sidebar: the tool table has no argument
column (arguments are in a collapsed section), and the OTX "rules vs. what happened" table
compares what the approved rules allowed with what actually started or was refused.
"""

import marimo

__generated_with = "0.25.1"
app = marimo.App(width="full")


@app.cell
def _():
    import json
    from pathlib import Path
    import marimo as mo
    from dsh_viztools.session import load_session
    from dsh_viztools.privacy import safe_tool_rows
    from dsh_viztools.plugin_state import attach_plugin_state, compact_tool_rows, plan_approval, rules_vs_outcome
    inputs = json.loads(Path(__file__).with_name("inputs.json").read_text(encoding="utf-8"))
    run = attach_plugin_state(load_session(inputs["trajectory"]), inputs.get("pluginState"))
    return compact_tool_rows, inputs, mo, plan_approval, rules_vs_outcome, run, safe_tool_rows


@app.cell
def _(inputs, mo, run):
    stats = run.summary
    mo.md(f"""
    # DSH session report

    **Session:** `{inputs['sessionId']}`  
    **Trigger:** `{inputs['trigger']}` at sequence **{inputs['triggerSeq']}**

    - **{stats['events']:,}** durable events · **{stats['turns']:,}** turns
    - **{stats['tool_calls']:,}** tool calls · **{stats['failed_tool_calls']:,}** failed
    - **{stats['total_tokens']:,}** reported tokens
    """)
    return


@app.cell
def _(mo, plan_approval, run):
    approval = plan_approval(run)
    if approval["markdown"] is None:
        plan_view = mo.md("## Plan\n\nNo plan was submitted in this session.")
    else:
        status = f"approved at **{approval['approved_at']}**" if approval["approved"] else "**not approved**"
        plan_view = mo.vstack([
            mo.md(f"## Plan: {approval['title']}\n\nStatus: {status}"),
            mo.accordion({"Plan text": mo.md(approval["markdown"])}),
        ])
    plan_view
    return


@app.cell
def _(mo, rules_vs_outcome, run):
    outcome = rules_vs_outcome(run)
    mo.vstack([
        mo.md("## Rules vs. what happened\nPer tool: the approved rule and limit, how many calls started, and how many were refused before and after plan approval."),
        mo.ui.table(outcome, pagination=True, page_size=20, selection=None) if outcome else mo.md("_No gate decisions were recorded for this session._"),
    ])
    return


@app.cell
def _(compact_tool_rows, mo, run, safe_tool_rows):
    mo.vstack([
        mo.md("## Tool calls"),
        mo.ui.table(compact_tool_rows(run), pagination=True, page_size=20, selection=None),
        mo.accordion({"Arguments (allowlisted, redacted, bounded)": mo.ui.table(safe_tool_rows(run.tool_calls), pagination=True, page_size=10, selection=None)}),
    ])
    return


@app.cell
def _(mo, run):
    explanation = run.explain_plan()
    mo.vstack([
        mo.md("## Approved run rules"),
        mo.ui.table(explanation.rules, pagination=True, page_size=20, selection=None) if explanation.rules else mo.md("_No run rules were approved._"),
    ])
    return


if __name__ == "__main__":
    app.run()
