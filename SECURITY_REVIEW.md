# Security review checklist

Release candidate: v1.0.0 (not promoted), reviewed against DSH 0.2.0-rc.2.

## Release decision

**Automated blockers: none open. OTX locked-console promotion still needs the manual/internal acceptance items below.**

History: the 2026-10-12 real-console review overturned an earlier "hardening complete" claim (remediation A–D). The 2026-10-13 run on the real OTX console (Fedora VM, GM E86) found a restart blocker and six more issues. All are fixed with tests, and `pnpm test:integration` exercises them in the real DSH web console. The re-run on the real OTX console should be repeated as part of internal acceptance.

## Automated evidence (2026-10-13)

`pnpm check`: 118 TypeScript tests and 31 Python tests pass. `pnpm test:integration` (real DSH 0.2.0-rc.2 web, OTX topology, mock LLM, late-registering MCP fixture, headless Chromium at 1910×916, restart + resume + repair): **41/41 checks pass**.

### Durable state and restart

- [x] No custom (non-ignorable) event types are written into `session.jsonl`. This is enforced at compile time (no `SessionEventMap` augmentation) and checked in integration.
- [x] Sessions reopen after a DSH restart and accept a new turn. Resumed counts equal live counts, and the resumed gate refuses at the limit (integration).
- [x] On rc.2: per-session sidecar, append-only, fsync'd per record, mode 0600, index plus SHA-256 hash chain, fork lineage up to the fork point. With `appendPluginRecord`: ignorable `plugin:dsh-viztools/*` records, detected at runtime.
- [x] Fail closed: a missing (with gated activity in the log), truncated, or edited sidecar means no plan approval, saved rules refused until re-approved, and limited tools refused for the session. A completed limited call without a recorded decision also makes counts untrusted.
- [x] `dsh-viztools-repair`: dry-run, backups, in-place `ignorable` conversion with sequence numbers preserved, state export, DSH's zstd frame layout kept, projection cache left in place. Validated with rc.2's own `validateStoredEvents` and by a real DSH reopen in integration.

### Policy

- [x] `run_code` is refused before approval unless `planFirst.allowPtcTransport` is set AND the file policy is confined; after approval it is governed like any tool (`THREAT_MODEL.md`).
- [x] Invalid saved rules fail closed: every governed tool is refused, with a `rules-invalidated` audit record. They never fall back to the deployment allowlist.
- [x] Delegation is refused while the gate is active unless `delegation.allow`. With the opt-in, children share the parent's approval, rules, and counts. Unattachable children get no fresh budget.
- [x] Not counted: aborts after the reservation but before the body, and tools that don't exist. Failed audit writes are retried and queued, and the call stays refused.
- [x] A missing plan mode is shown in the refusal text and in the viewer.
- [x] The earlier A–D evidence still holds: late MCP registration, isolated plan mode, outside workspace, all four plan-first/run-rules combinations, absent vs. empty allowlist, synchronous reservations, refusal audit at decision time, safe placeholder segments, resume-safe report state, authenticated sandboxed report route, uv `close` race.

### Viewer and report

- [x] The report iframe fills the sidebar (at least 60% of a 916 px viewport in integration). It is sandboxed without `allow-same-origin`, and `mo.iframe` auto-resize is not used.
- [x] The OTX report shows plan text and approval time, a "Rules vs. what happened" table, and a narrow tool table with arguments collapsed.
- [x] No secrets in logs or reports: sidecars and status files hold tool names, call IDs, codes, and reasons only. The screenshot in `docs/assets` has its token redacted. marimo stays bound to `127.0.0.1`.
- [x] The token is absent from the model-facing status schema; the marimo token file is mode 0600. Python dependencies are pinned with hashes.

## Manual/internal acceptance required

- [ ] Re-run on the real OTX console (Fedora VM) with real OTX tools: restart and reopen a gated session, and confirm the report fills the sidebar.
- [ ] Run `dsh-viztools-repair --dry-run`, then the real repair, on the existing console DSH home (stop all consoles first), and confirm the old sessions open.
- [ ] Approve rules in the real Client UI and capture refusal/limit evidence.
- [ ] Confirm internal `check-dsh-profile.py` enforces every item in `THREAT_MODEL.md` (including `allowPtcTransport`, `delegation.allow`, and matching state directories).
- [ ] Review and checksum the deployment's OTX report template.
- [ ] Validate the Phase F Podman image with networking disabled. The static export loads marimo frontend assets; confirm they render with networking off.
- [ ] Confirm that report and sidecar file permissions and retention satisfy internal policy.
- [ ] Review telemetry configuration for report/run data.

The content-block loader branch stays: real OTX trajectories mostly encode tool results through `message.source.callId` and `tool-result` content blocks.
