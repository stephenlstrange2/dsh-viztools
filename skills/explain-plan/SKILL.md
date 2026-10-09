---
name: explain-plan
description: Compare a submitted DSH plan with its execution, including native and MCP tools, failures, retries, and evidence.
---

# Explain a DSH plan

Use the live marimo notebook to explain what an approved or submitted plan proposed and what the trajectory records afterward.

1. Call `marimo_status` first and use its exact `notebook` path; never infer a parent `.dsh/notebooks` path. The root agent owns notebook edits/exports. Subagents may analyze a supplied trajectory but must not mutate the shared notebook and must receive these evidence rules explicitly.
2. Read the session with `dsh_viztools.session.load_session` and call `run.explain_plan()` (or select an earlier submission with `plan_index`).
3. Inspect `explanation.summary["plan_source"]` before making comparison claims:
   - `submitted`: use the durable `exit_plan_mode` plan;
   - `user-provided`: label it **User-provided plan; approval not observed**;
   - `reconstructed`: label it **Reconstructed plan; not an approved plan**;
   - `not-observed`: do not stop or invent a plan—produce an execution-only report and offer a plan-text input.
3. For a supplied fallback call `run.explain_plan(plan_markdown=text, source="user-provided"|"reconstructed", boundary_seq=...)`. If no exact boundary is known, use `boundary="session-start"` and disclose it.
4. Show comparison Markdown verbatim or in a collapsible section. Do not silently rewrite it.
5. Add a phase table from `explanation.phases`; it is legitimately empty in execution-only mode.
6. Add a native/MCP tool inventory. For MCP calls, show the parsed server and operation from names shaped like `mcp__<server>__<tool>`.
7. Add an execution timeline with call/result status, duration, failure code, and phase attribution.
8. Clearly distinguish evidence:
   - **direct**: the trajectory records the tool call/result and sequence boundary;
   - **heuristic**: a call is associated with a plan phase by keyword overlap;
   - **not observed**: no durable evidence supports the claim.
9. Report deviations conservatively: unmapped calls are unplanned or insufficiently attributable; a phase with no mapped call is not necessarily skipped because prose-only work may not use tools.
10. Keep all counts computed from `explanation.summary` or tables, never hand-copy them.
11. Run/inspect affected cells, fix errors, call `marimo_export_html`, and link both source and export.

The notebook executes Python with workspace-level authority. Stay inside the workspace and treat code as shell-equivalent.
