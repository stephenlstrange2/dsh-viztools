---
name: explain-with-notebook
description: Build a traceable interactive explanation in marimo and export it to HTML.
---

# Explain with marimo

1. Read source facts before editing. For a DSH trajectory, use `dsh_viztools.session.load_session`.
2. Add small reactive cells: data source, transformations, then a flow, table, chart, or timeline.
3. Add a short `mo.md` explanation beside each important result.
4. Compute every number from source data; do not hand-copy totals.
5. Run or inspect affected cells and fix errors.
6. Call `marimo_export_html` and link the notebook source and HTML export.

The live notebook executes Python with workspace-level authority. Treat code changes as shell-equivalent and stay inside the workspace.
