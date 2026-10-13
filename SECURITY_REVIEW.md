# Security review checklist

Release candidate: v1.0.0 (not promoted), reviewed against DSH 0.2.0-rc.2.

## Release decision

**Automated blockers: none open. OTX locked-console promotion still needs the manual/internal acceptance items below.**

History: the 2026-10-12 real-console review overturned an earlier "hardening complete" claim (remediation A–D). The 2026-10-13 run on the real OTX console (Fedora VM, GM E86) found a restart blocker and six more issues. All are fixed with tests, and `pnpm test:integration` exercises them in the real DSH web console. The re-run on the real OTX console should be repeated as part of internal acceptance.

## Automated evidence (2026-10-13)

`pnpm check`: 149 TypeScript tests and 33 Python tests pass. `pnpm test:integration` (real DSH 0.2.0-rc.2 web, OTX topology, mock LLM, late-registering MCP fixture, headless Chromium at 1910×916 and Firefox, restart + resume + repair + live-lease refusal): **53/53 checks pass**.

### Durable state and restart

- [x] No custom (non-ignorable) event types are written into `session.jsonl`. This is enforced at compile time (no `SessionEventMap` augmentation) and checked in integration.
- [x] Sessions reopen after a DSH restart and accept a new turn. Resumed counts equal live counts, and the resumed gate refuses at the limit (integration).
- [x] On rc.2: per-session sidecar, append-only, fsync'd per record, mode 0600. With `appendPluginRecord`: ignorable `plugin:dsh-viztools/*` records, detected at runtime.
- [x] Integrity is keyed: an HMAC-SHA256 chain with its key outside the workspace (`$DSH_HOME/viztools/sidecar.key`, 0600; a `keyDir` inside the workspace is rejected), plus a MAC'd out-of-workspace anchor (head and lineage). PoCs fail closed: forged unkeyed approval, whole-record tail truncation, deleted sidecar, tampered or missing anchor. *(The a751b39 chain was unkeyed; corrected.)*
- [x] Forks honour inherited approval and counts through recursive lineage (grandchildren included).
- [x] Records are bound to their session and channel; a grafted donor record fails. The anchor head is compared on every read, including after a reset, so truncating a post-reset narrowing rule fails closed. At most one record may lie beyond the anchor. *(Gaps in e27dbcf; corrected.)*
- [x] **Key readability:** the sidecar is tamper-evident only against agents that cannot read `$DSH_HOME`. While a file-reading tool is allowed (`run_code`, `bash`, `pwsh`, `read`, `read_image`, `grep`, `glob`, `str_replace_editor`, or `keyProtection.fileReadingTools`), every tool is refused unless a DSH-sandbox probe proves the key unreadable to tool subprocesses.
- [x] An unusable `keyDir` (inside the workspace by realpath, not owner-only, or a creation failure) denies all tools with a notice. Key creation is race-safe.
- [x] A malformed but authentic record, or unreadable state, denies every tool with a notice; agent creation never crashes.
- [x] Fail closed: a missing (with gated activity in the log), truncated, or edited sidecar means no plan approval, saved rules refused until re-approved, and limited tools refused for the session. A completed limited call without a recorded decision also makes counts untrusted.
- [x] `dsh-viztools-repair`: dry-run, unique fsync'd backups, in-place `ignorable` conversion with sequence numbers preserved, keyed state export, DSH's zstd frame layout kept, projection cache left in place. It takes DSH's `session.lock` lease (and is refused while a live DSH holds it, in integration), writes through unique exclusive temp files fsync'd before rename, and never re-exports a fork's inherited events. Validated with rc.2's own `validateStoredEvents` and by a real DSH reopen in integration.

### Policy

- [x] `run_code` is refused before approval unless `planFirst.allowPtcTransport` is set AND the effective file policy is confined (session override, else the `sandboxPolicy` deployment default); even then it must be in `allowedTools` and is refused while rules are invalid. After approval it is governed like any tool (`THREAT_MODEL.md`).
- [x] Invalid saved rules fail closed: every governed tool is refused, with a `rules-invalidated` audit record. They never fall back to the deployment allowlist.
- [x] Delegation is refused while the gate is active unless `delegation.allow`. With the opt-in, children share the parent's approval, rules, and counts. Unattachable children get no fresh budget.
- [x] Not counted: aborts after the reservation but before the body, and tools that don't exist. Failed audit writes are retried and queued, and the call stays refused.
- [x] A missing plan mode is shown in the refusal text and in the viewer.
- [x] The earlier A–D evidence still holds: late MCP registration, isolated plan mode, outside workspace, all four plan-first/run-rules combinations, absent vs. empty allowlist, synchronous reservations, refusal audit at decision time, safe placeholder segments, resume-safe report state, authenticated sandboxed report route, uv `close` race.

### Viewer and report

- [x] The report iframe fills the sidebar (at least 60% of a 916 px viewport in integration). It is sandboxed without `allow-same-origin`, and `mo.iframe` auto-resize is not used. An in-memory storage shim keeps marimo's storage access from throwing in the opaque origin; in Firefox, the report renders after two viewer reloads without "Something went wrong" (integration).
- [x] The OTX report shows plan text and approval time, a "Rules vs. what happened" table, and a narrow tool table with arguments collapsed.
- [x] No secrets in logs or reports: sidecars and status files hold tool names, call IDs, codes, and reasons only. The screenshot in `docs/assets` has its token redacted. marimo stays bound to `127.0.0.1`.
- [x] The token is absent from the model-facing status schema; the marimo token file is mode 0600. Python dependencies are pinned with hashes.

## Manual/internal acceptance required

- [ ] Re-run on the real OTX console (Fedora VM) with real OTX tools: restart and reopen a gated session, and confirm the report fills the sidebar.
- [ ] Run `dsh-viztools-repair --dry-run`, then the real repair, on the existing console DSH home (stop all consoles first), and confirm the old sessions open.
- [ ] Approve rules in the real Client UI and capture refusal/limit evidence.
- [ ] Confirm internal `check-dsh-profile.py` enforces every item in `THREAT_MODEL.md` (including `allowPtcTransport`, `delegation.allow`, matching state directories, a `keyDir` outside the agent's writable paths, and no unconfined file-reading tools, including MCP readers listed in `keyProtection.fileReadingTools`).
- [ ] Review and checksum the deployment's OTX report template.
- [ ] Validate the Phase F Podman image with networking disabled. The static export loads marimo frontend assets; confirm they render with networking off.
- [ ] Confirm that report and sidecar file permissions and retention satisfy internal policy.
- [ ] Review telemetry configuration for report/run data.

The content-block loader branch stays: real OTX trajectories mostly encode tool results through `message.source.callId` and `tool-result` content blocks.
