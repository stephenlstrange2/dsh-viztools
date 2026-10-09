# OTX hardening remediation

Status: **release blocked**

Phase 0 freezes the 2026-10-09 review findings as 22 named acceptance contracts in `test/otx-hardening.todo.test.ts`. They remain `it.todo` so developer-mode tests can run, but their count is release evidence: v1 and locked-console promotion are forbidden while any remain.

## Phase sequence

1. Monotonic fail-closed gate and deployment baseline — **complete 2026-10-09**
2. Monotonic rule merges, replay-stable counters, deployment fingerprint, fork policy — **complete 2026-10-09**
3. Post-commit terminal report trigger, timeout/cancellation, turn coalescing
4. Stable locked placeholder/current-report app
5. Durable run-id input resolution
6. Token file, realpath containment, safe session paths, lock-content marker
7. Default report argument redaction and bounds
8. Real ToolRuntime/Agent-loop OTX acceptance suite

Complete exactly one phase at a time. Convert its todo tests into active assertions, make them green, update `SECURITY_REVIEW.md`, and stop for review with a commit message.

## Baseline evidence

```text
53 passed | 12 todo
9 Python tests passed
```

Representative fixtures include modern content-block `tool/result`, terminal `finalize_run`, PTC dispatch start, and approved gate state. The content-block loader branch must remain.
