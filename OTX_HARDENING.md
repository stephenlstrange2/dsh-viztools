# OTX hardening remediation

Status: **release blocked**

## History

Phases 1–8 (2026-10-09 → 2026-10-12) closed the 22 contracts from the first architecture review (`test/otx-hardening.todo.test.ts`). A review on the real OTX console then showed the plugin still was not ready: those suites ran against fixtures, not the real composition. Remediation phases A–D followed, along with a real-profile integration test.

## Remediation (2026-10-12)

- **A. Boot blockers — fixed.** Removed the agent-creation tool-visibility check, because MCP tools register later and `run_code` exists only in PTC mode. Plan mode now resolves from the gate's isolated preset scope, then the agent scope. The bundled locked viewer is exempt from workspace containment but pinned to its real path inside the package.
- **B. Policy and count leaks — fixed.** Absent and empty allowlists are now distinct, and v3 events still decode legacy v2 logs. All four `planFirst`/`runRules` combinations work. Control tools are auto-allowed and `denialMessage` is used. Limits use synchronous reservations plus durable `started-call` events.
- **C. Durable refusal audit — fixed.** The final guard refusal is persisted when the decision is made, deduplicated per call.
- **D. Report viewer — fixed.** The viewer validates session IDs and embeds the contained report. Finished exports are served on an authenticated, CSP-sandboxed route. The viewer polls while pending, resume keeps finished state, placeholder values must be single safe path segments, and background report work has no unhandled rejections.
- **Integration.** `pnpm test:integration` boots real DSH 0.2.0-rc.2 web with the OTX preset topology. Its MCP fixture registers tools late, plan mode and the gate run in the isolated `planning` group, presentation is native, the runtime is managed-readonly from an outside workspace, and approvals are automatic. It asserts on the durable log, the bench call log, the report route, the viewer, and restart behavior.
- The harness also found, and this round fixed, two bugs no unit test covered: `propose_run_rules` validated against the global tool view, so preset-scoped MCP tools were invisible to it, and the uv probe raced `exit` against `close`, which broke the second boot.

## Open blocker: durable plugin state across restart

DSH 0.2.0-rc.2 refuses to load any session log that has a non-ignorable event of an unknown type. Plugins cannot write the `ignorable` marker through rc.2's `Session.append`. As a result, every session that recorded `viztools-gate/change`, `viztools-run-rules/change`, or `viztools-report/change` fails to reopen after a restart ("Failed to load history … unknown to this harness"). Live sessions are unaffected.

Options (decision required):

1. **Move to DSH 0.2.1-alpha `appendPluginRecord`** (`plugin:dsh-viztools/...` records). This is the supported mechanism, but it is experimental, and records are kept only best-effort across format migrations. Lost approval fails closed, but lost `started-call` counts would widen limits. That would need a fail-closed rule, such as refusing limited tools when the record chain looks truncated.
2. **Stay on rc.2 with a plugin-owned sidecar log** (per session, append-only, fsync'd, under the workspace `.dsh/`), keeping the session log clean. This needs explicit fork-lineage handling, and ordering against the session log is no longer atomic.
3. **Both:** use the sidecar on rc.2 and plugin records when available.

Existing logs that already contain these events also need a repair or migration path.

## Evidence

```text
pnpm check: 87 TypeScript passed, 22 Python passed
pnpm test:integration: 29/31 passed (2 failures = open blocker above)
```
