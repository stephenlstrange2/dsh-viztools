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

## Follow-up on e27dbcf (2026-10-13, PoCs reproduced)

1. **HIGH:** records were not bound to the reader's session, and the anchor head was skipped after a reset. Now the MAC is verified with the reader's session and channel, and the head is always compared, so post-reset truncation of a narrowing rule triggers a new reset. Tests: `state-store`, `gate-runtime`.
2. **HIGH:** the agent can read the key, because DSH's sandbox only restricts writes. The sidecar is now documented as tamper-evident only against agents that cannot read `$DSH_HOME`, and the gate denies all tools while a file-reading tool is allowed, unless a probe through DSH's sandbox proves the key unreadable. `THREAT_MODEL.md` is corrected. Tests: `gate-runtime`.
3. **MEDIUM:** an unusable `keyDir` denies all tools with a notice instead of throwing; key creation is race-safe (temp file plus hard link, readers retry). Tests: `gate-runtime`, `state-store`, `report-resume`.
4. **LOW:** realpath `keyDir` check, owner-only permission checks, at most one record beyond the anchor. Tests: `state-store`, `gate-runtime`.
5. **Docs:** a751b39 sessions: delete the old sidecar and anchors, restore the original log from the backup, repair again — or start new sessions (README).
6. **Firefox viewer:** an in-memory storage shim is the first element of the srcdoc `<head>`; the sandbox is unchanged. Tests: `test_managed_view.py` and the integration Firefox phase (two viewer reloads).

## Follow-up on 804fbef (2026-10-13, PoC r1 reproduced)

1. **HIGH:** a replay of the session's own old reset segment widened the rules again. Now indices strictly increase across the file, a reset is accepted only at the next index, and the anchored head must be the last record (or second-to-last in the crash window). Tests: `state-store`, `gate-runtime`.
2. **MEDIUM:** file readers are deny-by-default (`keyProtection.safeTools`), and a probe can never clear in-process readers, `read_mcp_resource`, or MCP tools. Tests: `gate-runtime`. Migration: the OTX console lists `mcp__otx__*` as safe.
3. **LOW:** the shim is anchored to the real `<head>` (`html.parser`); the key wait no longer blocks; an own 0755 key directory is tightened, and a leaked key file is explained. Tests: `test_managed_view.py`, `state-store`, `gate-runtime`.

## LOW follow-ups on 8bbc07f (2026-10-13)

1. `safeTools` is trimmed and validated, and `mcp__<server>__*` is scoped to exactly that server. An invalid gate config now denies all tools instead of failing open. Tests: `gate-runtime`.
2. A group- or world-writable key directory is refused rather than tightened; anchor files must be our own, not linked, and not group-writable. Tests: `state-store`.
3. The report retries after a `KeyNotReady` timeout instead of disabling reports. Tests: `report-resume`.

## Evidence

```text
pnpm check:            165 TypeScript tests, 34 Python tests passed
pnpm test:integration: 53/53 checks passed (Chromium + Firefox; restart, resume, repair, live-lease refusal)
```

## Remaining (not automatable here)

Internal acceptance items in `SECURITY_REVIEW.md`: a real OTX bench run, the internal profile checker, the template checksum, disconnected Podman, retention, and telemetry.
