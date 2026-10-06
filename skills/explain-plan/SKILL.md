---
name: explain-plan
description: Compare a submitted DSH plan with its execution, including native and MCP tools, failures, retries, and evidence.
---

# Explain a DSH plan

Use the live marimo notebook to explain what an approved or submitted plan proposed and what the trajectory records afterward.

1. Read the session with `dsh_viztools.session.load_session` and call `run.explain_plan()` (or select an earlier submission with `plan_index`).
2. Show the submitted Markdown plan verbatim or in a collapsible section. Do not silently rewrite it.
3. Add a phase table from `explanation.phases`.
4. Add a native/MCP tool inventory. For MCP calls, show the parsed server and operation from names shaped like `mcp__<server>__<tool>`.
5. Add an execution timeline with call/result status, duration, failure code, and phase attribution.
6. Clearly distinguish evidence:
   - **direct**: the trajectory records the tool call/result and sequence boundary;
   - **heuristic**: a call is associated with a plan phase by keyword overlap;
   - **not observed**: no durable evidence supports the claim.
7. Report deviations conservatively: unmapped calls are unplanned or insufficiently attributable; a phase with no mapped call is not necessarily skipped because prose-only work may not use tools.
8. Keep all counts computed from `explanation.summary` or tables, never hand-copy them.
9. Run/inspect affected cells, fix errors, call `marimo_export_html`, and link both source and export.

The notebook executes Python with workspace-level authority. Stay inside the workspace and treat code as shell-equivalent.
