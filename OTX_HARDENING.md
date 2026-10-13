# OTX hardening remediation

Status: **automated blockers closed; internal acceptance pending** (see `SECURITY_REVIEW.md`)

## History

- Phases 1–8 (2026-10-09 → 2026-10-12) closed the 22 contracts from the first architecture review (`test/otx-hardening.todo.test.ts`).
- Remediation A–D (2026-10-12) fixed the boot blockers, policy and count leaks, refusal audit, and report viewer found on the real console, and added `pnpm test:integration`.
- 2026-10-13: a real OTX console run (DSH 0.2.0-rc.2, Fedora VM, GM E86) produced the findings below, now fixed.

## 2026-10-13 findings

1. **BLOCKER: sessions could not be reopened after a console restart.** The log was refused with "contains event type `viztools-run-rules/change` … unknown to this harness and not marked ignorable". The same refusal blocked a second console sharing the DSH home.
   - **Fix (option 3):** the plugin writes no custom event types into `session.jsonl`. On rc.2, state goes to a plugin-owned sidecar: per session and channel, append-only, fsync'd, 0600, hash-chained, with fork lineage. On DSH versions with `appendPluginRecord`, ignorable `plugin:dsh-viztools/*` records are used instead, detected at runtime.
   - **Fail closed:** a missing or truncated sidecar (or a completed limited call with no recorded decision) means no plan approval, saved rules refused until re-approved, and limited tools refused for the session.
   - **Repair:** `dsh-viztools-repair` (dry-run, backups) converts legacy events to `ignorable` in place and exports their state.
   - **Tests:** `test/gate-runtime.test.ts`, `test/state-store.test.ts`, `test/repair.test.ts`, plus the integration restart, resume, counts, and repair checks.
2. **BUG: the viewer showed an 85 px strip.** Replaced `mo.iframe` (auto-resize) with a sandboxed `srcdoc` iframe at `80vh`. Tests: `test/test_managed_view.py`, plus the integration check at 1910×916 that the frame is at least 60% of the viewport height.
3. **HIGH: `run_code` bypassed the gate.** It is now refused before approval unless `planFirst.allowPtcTransport` is set and the file policy is confined; after approval it is governed like any tool. Documented in `THREAT_MODEL.md`. Tests: `gate-runtime`, `gate-policy`, `otx-hardening`.
4. **MEDIUM: invalid saved rules widened access.** Now every governed tool is refused, with a message and a `rules-invalidated` record. Tests: `gate-runtime`, `gate-policy`.
5. **MEDIUM: delegated children escaped the parent's limits.** Delegation is refused unless `delegation.allow`; with the opt-in, children share the parent's gate. Tests: `gate-runtime`, `gate-policy`.
6. **LOW:**
   - a missing plan mode is now shown to the user (refusal text and viewer);
   - aborts before the body runs and calls to unknown tools are not counted;
   - failed audit writes are retried, then queued.

   Tests: `gate-runtime`, `test_managed_view.py`.
7. **Report content:** plan text and approval time, "Rules vs. what happened", and a narrow tool table. Tests: `test/test_plugin_state.py`.

## Follow-up on a751b39 (2026-10-13, reproduced with PoCs)

1. **HIGH:** the hash chain was unkeyed, so forged appends and tail truncation went undetected. Now an HMAC-SHA256 chain with the key in `$DSH_HOME/viztools` (outside the workspace), plus a MAC'd anchor with the head and lineage. `THREAT_MODEL.md` is corrected. Tests: `state-store`, `gate-runtime` (PoCs).
2. **Forks:** inherited approval is valid through lineage, and lineage is recursive. Tests: `state-store`, `gate-runtime`.
3. **run_code before approval** also requires `allowedTools` and valid rules, and reads the deployment default mode from `sandboxPolicy`. Tests: `gate-runtime`.
4. **Repair:** takes the `session.lock` lease or refuses; unique exclusive temp files fsync'd before rename; a fork's inherited events are not re-exported. Tests: `repair`, integration (refused while live).
5. **Malformed state** denies all tools with a notice instead of crashing agent creation. Tests: `gate-runtime`, `test_managed_view.py`.

## Evidence

```text
pnpm check:            133 TypeScript tests, 31 Python tests passed
pnpm test:integration: 42/42 checks passed (real DSH 0.2.0-rc.2 web, OTX topology, restart + resume + repair, live-lease refusal)
```

## Remaining (not automatable here)

Internal acceptance items in `SECURITY_REVIEW.md`: a real OTX bench run, the internal profile checker, the template checksum, disconnected Podman, retention, and telemetry.
