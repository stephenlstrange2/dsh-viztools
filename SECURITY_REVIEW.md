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

## Release decision

The public repository can establish package behavior and fixture-level security properties. It cannot establish internal OTX composition, hardware bench behavior, customer-data retention, or internal profile-checker acceptance. Do not promote the plugin to the locked console until the manual/internal items above are signed off.
