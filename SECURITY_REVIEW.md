# Security review checklist

Release candidate: v1.0.0 (not promoted), reviewed against DSH 0.2.0-rc.2.

## Release decision

**OTX locked-console promotion is BLOCKED.**

The 2026-10-12 real-console review showed that the earlier "automated hardening complete" claim was wrong: every session failed at creation, the locked runtime refused to boot, and several policy and count paths leaked. Those defects are fixed (remediation phases A–D below), and a new real-profile integration test (`pnpm test:integration`) now boots the real DSH web console in the OTX topology.

That test found one more blocker that this plugin cannot fix on DSH 0.2.0-rc.2:

> **Sessions that record any dsh-viztools durable event cannot be reopened after a DSH restart.** DSH 0.2.0-rc.2 persistence refuses to load a log that has an unknown event type without the `ignorable` envelope marker. `Session.append` in rc.2 cannot set that marker. DSH added the supported writer, `appendPluginRecord` (`plugin:` namespace), only in 0.2.1-alpha, and documents it as experimental and best-effort across format migrations.

Promotion needs a decision on durable-state storage (see the "Open blocker" section in `OTX_HARDENING.md`). It also still needs the manual/internal items below.

## Automated evidence (2026-10-12)

`pnpm check`: 87 TypeScript tests and 22 Python tests pass. `pnpm test:integration` (real DSH web console, mock LLM, stdio MCP fixture, headless browser): 29/31 checks pass. The 2 failures are the persistence blocker above.

- [x] Sessions are created even though MCP tools register after the agent exists; `run_code` is not required in native presentation.
- [x] Plan mode resolves from the preset `planning` group that isolates `planMode`; a missing service logs a warning and fails closed, without breaking session creation.
- [x] Locked mode boots from a workspace outside the plugin directory. The bundled viewer app is pinned to its real path inside the package.
- [x] All four `planFirst` × `runRules` combinations behave as configured. `denialMessage` is used. Control tools (`exit_plan_mode`, `propose_run_rules`, `run_code`) are always callable.
- [x] An absent allowlist means "deployment ceiling only". An empty allowlist, including an empty intersection of disjoint approvals, denies everything.
- [x] Limits use synchronous reservations plus durable `started-call` events. Parallel calls cannot overshoot, failed started calls count, refused calls do not, and live state equals replayed state (integration: exactly 1 of 2 parallel replays reaches the bench).
- [x] Final guard refusals are written once each, at decision time (integration: pre-approval refusal, limit refusal, and session-rule refusal are all in the live log).
- [x] Planning tools stay under the deployment ceiling and session rules after approval.
- [x] Placeholder values must be a single safe path segment, even when the deployment regex is permissive.
- [x] Report state is not reset to `pending` when an agent is resumed (unit test). Report background work has no unhandled rejections.
- [x] The authenticated report route (`/api/viztools/report?session=`) serves only a contained `available` export, inside a CSP sandbox with an opaque origin. Unauthenticated requests get 401 and traversal IDs get 400 (integration).
- [x] The locked viewer validates session IDs, embeds the contained report, polls while pending, and offers the authenticated link (integration).
- [x] The uv version probe and command runners read output on `close`, fixing a restart race that blocked a real second boot.
- [x] Token is absent from model-facing status schema; marimo token file is mode 0600.
- [x] Python dependencies are pinned with hashes.

## Open automated blocker

- [ ] Durable plugin state that survives a restart (see `OTX_HARDENING.md`, "Open blocker").

## Manual/internal acceptance required

- [ ] Run the gate against real OTX tools in the internal profile.
- [ ] Approve rules in the real Client UI and capture refusal/limit evidence.
- [ ] Confirm internal `check-dsh-profile.py` enforces every item in `THREAT_MODEL.md`.
- [ ] Review and checksum the deployment's OTX report template.
- [ ] Validate the Phase F Podman image with networking disabled. The static export loads marimo frontend assets; confirm they render with networking off.
- [ ] Confirm generated report file permissions and retention satisfy internal policy.
- [ ] Review telemetry configuration for report/run data.

The content-block loader branch stays: real OTX trajectories mostly encode tool results through `message.source.callId` and `tool-result` content blocks.
