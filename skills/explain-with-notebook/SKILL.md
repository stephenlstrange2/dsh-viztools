---
name: explain-with-notebook
description: Build a traceable interactive explanation in marimo and export it to HTML.
---

# Explain with marimo

1. **Call `marimo_status` first.** Its `notebook` value is the only authoritative notebook path. Use that exact absolute path for every read/write/edit. Never infer `.dsh/notebooks` from the conversation cwd or a parent directory.
2. Read source facts before editing. For a DSH trajectory, use `dsh_viztools.session.load_session`.
3. The root agent owns notebook mutation and export. Subagents may inspect data and return analysis, but must not edit or export the shared notebook. If delegating analysis, include the trajectory path and these evidence rules explicitly; do not assume a child inherited this skill.
4. Read the authoritative notebook before overwriting it, then add small reactive cells: data source, transformations, and a flow, table, chart, or timeline.
5. Add a short `mo.md` explanation beside each important result. Compute every number from source data; never hand-copy totals.
6. Validate the exact managed notebook using the live marimo code-mode tools or a full script/export execution. Treat any failed write, edit, MCP call, kernel check, or export as a hard failure: fix it before claiming success.
7. Call `marimo_export_html` and verify the output contains the expected computed sections. Link the authoritative notebook source and HTML export.
8. Do not claim the sidebar hot-reloaded or the kernel is healthy unless the live managed path was successfully validated.

The live notebook executes Python with workspace-level authority. Treat code changes as shell-equivalent and stay inside the workspace.
