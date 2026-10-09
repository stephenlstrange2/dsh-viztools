# Security review checklist

Release candidate: v1.0.0  
Reviewed against DSH: 0.2.0-rc.2

## Automated evidence

- [x] Plan gate defaults closed and durable approval/refusal events replay.
- [x] Fork seed inherits gate approval state.
- [x] Native and PTC dispatches share policy enforcement.
- [x] Run rules reject widening and over-cap limits.
- [x] Token is absent from model-facing status schema.
- [x] Sidebar URL route requires authenticated DSH browser session.
- [x] Report identity is stable across replay and template revisions.
- [x] Code-free export tested against a real compressed trajectory.
- [x] Managed-readonly registers no marimo model tools, skills, or MCP bridge.
- [x] Managed-readonly serves only an existing notebook under `managedReportRoot` with `marimo run`.
- [x] `/mcp/server` returned HTTP 404 in the disposable locked profile.
- [x] Python dependencies are pinned with hashes and install from a verified offline uv cache.
- [x] OTX-like durable lifecycle fixture covers plan approval → rules/limit → final report → locked-profile validation.

## Manual/internal acceptance required

- [ ] Run the gate against real OTX tools in the internal profile.
- [ ] Approve rules in the real Client UI and capture refusal/limit evidence.
- [ ] Confirm internal `check-dsh-profile.py` enforces every item in `THREAT_MODEL.md`.
- [ ] Review and checksum the deployment's OTX report template.
- [ ] Validate the Phase F Podman image with networking disabled.
- [ ] Confirm generated report file permissions and retention satisfy internal policy.
- [ ] Review telemetry configuration for report/run data.

## OTX hardening release block

The 2026-10-09 architecture review found critical gaps in enforcement ordering, replay-stable policy, terminal-report timing, locked report display, runtime secret/path handling, and report privacy. These are captured as named `it.todo` acceptance contracts in `test/otx-hardening.todo.test.ts` with representative OTX event shapes in `test/fixtures/otx-events.ts`.

- [ ] Phase 1: monotonic fail-closed gate and enforced deployment baseline
- [ ] Phase 2: monotonic rules, replay-stable committed counters, stricter-deployment replay validation, fork policy
- [ ] Phase 3: report only after matching durable terminal result; timeout/cancellation/coalescing
- [ ] Phase 4: stable locked placeholder/current-report app
- [ ] Phase 5: durable run-id artifact resolution
- [ ] Phase 6: token file, realpath containment, safe session directory identity, lock-content marker
- [ ] Phase 7: default report argument redaction/bounds
- [ ] Phase 8: real ToolRuntime/Agent-loop OTX acceptance suite

The existing content-block loader branch is explicitly retained: real OTX trajectories predominantly encode tool results through `message.source.callId` and `tool-result` content blocks.

## Release decision

**v1 and locked-console promotion are blocked.** The public repository can establish package behavior and fixture-level security properties, but the Phase 0 todo inventory is deliberately unfinished. Do not promote the plugin to the locked console until every hardening todo is implemented and green, and the manual/internal items above are signed off.
