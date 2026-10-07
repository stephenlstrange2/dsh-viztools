# dsh-viztools roadmap

This roadmap takes `dsh-viztools` from a developer visualization plugin to a component that can run inside a locked internal console (OTX). It follows the gap analysis from the first internal integration review.

## Guiding decisions

- **uv stays a hard requirement.** The plugin keeps provisioning its Python environment with uv. Offline deployments are handled by pointing uv at a local index or wheel folder and a pre-populated cache, not by adding alternative runtime providers.
- **Enforcement is separate from visualization.** Plan approval, run rules, and refusal auditing must keep working when marimo is disabled. They ship in the same package but as separate Cordis entries.
- **The token never reaches the model.** Authenticated marimo URLs travel Host → authenticated Client only.
- **Policy only narrows.** Session rules are intersected with the deployment policy; they can never widen it.
- **Reports are built by the plugin, not written by the agent.** The agent may add a short summary afterwards.
- **Every claim in a report is labelled** as enforced, direct evidence, heuristic, or not observed.

## Current state (v0.1)

| Capability | Status |
|---|---|
| uv-managed marimo runtime, loopback + random token | Done |
| marimo code-mode MCP through `dsh-mcp-client` | Done |
| `marimo_status`, `marimo_export_html` tools | Done (status leaks the token to the model) |
| `explain-with-notebook`, `explain-plan` skills | Done |
| Session loader (plaintext + zstd, DSH 0.2 tool-result shape) | Done |
| `explain_plan()` with submitted / provided / reconstructed / execution-only sources | Done |
| Automatic sidebar opening | Not started |
| Plan gate, run rules, automatic report, locked-console mode | Not started |

## Milestone 0 — Stabilize the baseline

Goal: a committed, reviewable baseline before security work starts.

- [x] Commit the original baseline; the current milestone changes, including the DSH 0.2 loader fix, remain ready for the milestone commit.
- [x] Add a regression test for `tool/ptc-dispatch` failures. Its `isError` lives on `event.data`, so `plan.py` is correct there; the test pins that.
- [x] Decide and document the DSH compatibility policy in `COMPATIBILITY.md`: exact internal pins, one tested pre-release line at a time, and compatibility CI before widening.
- [x] Split the package into three Cordis entries:
  - `dsh-viztools/runtime` — marimo process, MCP bridge, export;
  - `dsh-viztools/gate` — plan gate and run rules;
  - `dsh-viztools/report` — automatic report.

  The default bundle patch enables `runtime` only, so existing developer profiles keep working. `gate` and `report` are inert reserved entries until their milestones.

Exit criteria: `pnpm check` green, milestone commit ready, and all three entries load independently in a test profile. Tagging `v0.1.1` follows the milestone commit.

**Milestone status: complete (2026-10-06).** `pnpm check` passes; runtime, inert gate, and inert report entries booted together in the disposable `viztools-test` profile without activation warnings. Changes are intentionally left uncommitted for review.

## Milestone 1 — Plan gate (gap A)

Goal: a new session cannot run non-planning tools until the user approves a plan.

Configuration:

```yaml
- id: dsh-viztools-gate
  name: dsh-viztools/gate
  config:
    planFirst:
      enabled: true
      planningTools: [bench_status, describe_profile, parse_snoop, get_messages]
      denialMessage: Plan not approved yet.
```

Work:

- [x] Enter plan mode for new and unapproved resumed sessions through `ctx.planMode`.
- [x] Keep a gate state machine separate from plan mode: `closed → approved`. Plan mode is guidance; the gate is enforcement.
- [x] Register a scoped `tools/pre-execute` policy that refuses every tool outside `planningTools` (plus `exit_plan_mode`) while closed, including PTC sub-dispatches.
- [x] Open the gate only on a successful `{ approved: true }` result from `exit_plan_mode`. Rejection, "keep planning", dismissal, `/plan off`, and reload during review leave it closed.
- [x] Persist versioned gate approval/refusal changes as session events and rebuild state from the complete log on resume.
- [x] Define fork behavior: a fork inherits the parent's gate state at the fork cut through its seed.
- [x] Validate at agent activation that every configured planning tool and `exit_plan_mode` is visible.

Tests cover durable approval/refusal folds, resume before/after approval, fork inheritance, PTC dispatch error shape, config normalization/rejection, independent entry loading, and full profile activation. The scoped policy sits at `tools/pre-execute`, so native and PTC calls share the same denial path.

Exit criteria: in an OTX test profile, `propose_sequence`, `emit_otx`, `replay_tx_only`, `diff`, and `finalize_run` are refused with "Plan not approved yet." until Approve is clicked, and the refusals appear in the trajectory.

**Milestone status: implementation complete (2026-10-06).** The gate boots enabled in the disposable Web profile and all automated checks pass. OTX-specific tool names require the internal OTX profile for the final acceptance run; the generic enforcement path and durable audit model are complete. Changes are left uncommitted for review.

## Milestone 2 — Secure sidebar (gap B)

Goal: marimo opens automatically and its token never enters the session log.

- [x] Add an authenticated exact Fetch route that returns the current marimo URL to the operator client only, with `Cache-Control: no-store`.
- [x] Client half calls `ctx.sidebarRight.openTab('browser', { params: { url } })` when a session is mounted and after a connection reset.
- [x] Resolve the current URL at open time rather than injecting it into Client configuration or model context.
- [x] Remove `browserUrl` from the model-facing `marimo_status` result. Keep notebook path, port, and readiness metadata only.
- [x] Make automatic opening functional through the package Client entry.

Tests cover strict Client payload parsing and source-level separation of the model tool from the secret Host route. Disposable-profile smoke tests confirmed the authenticated route returns the URL, an unauthenticated request receives HTTP 401, and the current workspace's stored session files contain no `access_token=` string.

Exit criteria: grep of the session log for the access token returns nothing; the notebook opens with no user action.

**Milestone status: implementation complete (2026-10-06).** The runtime and Client bundle boot without activation warnings, and authenticated/unauthenticated route behavior is verified. Manual visual confirmation of tab opening remains part of the browser acceptance pass because the headless fixture has no pre-existing mounted Session; the landing-page screenshot was removed because it demonstrated no milestone behavior.

## Milestone 3 — Run rules from the approved plan (gap C)

Goal: the approved plan carries machine-readable rules that the plugin enforces.

Transport: a `propose_run_rules` tool with a typed schema, approved together with the plan. A fenced `run-rules` YAML block in the plan Markdown is accepted as an authoring convenience but converted to the same typed value before approval.

```json
{
  "version": 1,
  "allow": ["mcp__otx__*"],
  "deny": ["mcp__marimo__*", "replay_tx_only"],
  "limits": { "replay_tx_only": 2 },
  "notes": ["no edits after step 40"]
}
```

Work:

- [ ] Effective policy = deployment policy ∩ approved rules. Never a union.
- [ ] Reject rules that name a tool outside the deployment's allowed set (a user can deny `replay_tx_only`, but can never enable `bash` in the console).
- [ ] Cap numeric limits at the deployment limit (`OTX_MAX_REPLAYS` for OTX).
- [ ] Enforce allow/deny with `ctx.tools.restrict` plus a guard; enforce counts with a guard over durable counters.
- [ ] Inject free-text `notes` as prompt text and mark them **not enforced**.
- [ ] Persist `run-rules/approved`, `run-rules/refused-call`, and `run-rules/limit-reached` events.
- [ ] Extend `explain_plan()` with a "rules vs. what happened" table:

  | Rule | Enforcement | Observed |
  |---|---|---|
  | deny `emit_otx` | enforced | 1 refused call |
  | max `replay_tx_only` = 2 | enforced | 2 allowed, 1 refused |
  | no edits after step 40 | advisory | not verified |

Tests: widening attempts rejected, limit above cap rejected, wildcard matching, counters across resume, refusal events recorded.

Exit criteria: an OTX session with approved rules shows enforced refusals in both the trajectory and the report.

## Milestone 4 — Automatic report (gap D)

Goal: the plugin builds and exports the report at the end of a run without the agent writing it.

```yaml
- id: dsh-viztools-report
  name: dsh-viztools/report
  config:
    triggerTools: [finalize_run, abandon_run]
    triggerOnTurnStop: false
    template: ./templates/otx-report.py
    includeCode: false
    extraInputs:
      auditLog: runs/{runId}/audit.jsonl
      manifest: runs/{runId}/manifest.json
      report: runs/{runId}/report.md
```

Work:

- [ ] Resolve the current session's trajectory path through a host service, never by guessing the directory layout.
- [ ] One notebook and export per session: `.dsh/reports/<session-id>/report.py` and `report.html`, replacing the shared `explanation.py`.
- [ ] Trigger after a configured terminal tool result, or at turn end (`agent/turn-stopping`, as `dsh-inline-figures` does).
- [ ] Make generation idempotent on `(session id, trigger seq, template version)`.
- [ ] Let profiles supply their own template; pass inputs as structured data (trajectory, plan, rules, refusals, extra files), not generated code.
- [ ] Export without code using marimo's no-code HTML option for the pinned version.
- [ ] Record a `report/available` event and present the file as a deliverable; the agent adds a short summary.
- [ ] Do not depend on `tool-skill`; skills remain a developer convenience.
- [ ] Ship a default template based on `examples/explain-plan.py`.

Tests: trigger fires once across restart, missing extra input is reported not fatal, template error produces a visible failed report record.

Exit criteria: finishing an OTX run produces a code-free HTML report linked in the final turn with no agent tool calls involved.

## Milestone 5 — Locked-console mode

Goal: the plugin can pass `check-dsh-profile.py` in the OTX console.

```yaml
- id: dsh-viztools
  config:
    mode: managed-readonly
```

In `managed-readonly`:

- [ ] `mcpCodeMode` is forced off and the marimo MCP bridge is not registered.
- [ ] No model-facing notebook editing tools; the agent can read and explain only.
- [ ] Templates come only from trusted deployment configuration paths.
- [ ] Notebook execution is triggered only by the report service.
- [ ] marimo runs in `marimo run` (app) mode rather than `edit` mode for viewing.
- [ ] Document that trusted templates still run as the console user and add that to the console threat model.
- [ ] Add a profile-check rule: `mode: managed-readonly` required when the console profile is detected.

Exit criteria: profile checker accepts the console profile; the agent has no path to execute new Python.

## Milestone 6 — Offline installs with uv

Goal: bench PCs and the Phase F Podman bundle install without PyPI, while uv remains the only supported installer.

- [ ] Add config for uv offline sources:

  ```yaml
  uv:
    command: uv
    indexUrl: file:///opt/dsh-viztools/wheels   # or an internal mirror
    offline: true
    cacheDir: /opt/dsh-viztools/uv-cache
    pythonInstallDir: /opt/dsh-viztools/python
  ```

- [ ] Pass these through as `--offline`, `--find-links`/`--index-url`, `UV_CACHE_DIR`, and `UV_PYTHON_INSTALL_DIR`.
- [ ] Add a `pnpm run wheelhouse` script that downloads pinned wheels (marimo, `zstandard`, template deps) and a uv-managed Python build into a folder for transfer.
- [ ] Add a lock file for the Python environment and verify hashes.
- [ ] Document the Podman bundle: bake the wheel folder and uv cache into the image.
- [ ] Startup error message names uv explicitly when it is missing.
- [ ] Document the supported uv version range and fail startup when the installed uv is outside it.

Exit criteria: a fresh bench PC with uv and no network provisions the environment from the wheel folder.

## Delivery waves

| Wave | Milestones | Deliverable | Rough effort |
|---|---|---|---|
| 1 — Secure control | M0 + M1 | Stable baseline and enforceable approval gate | 1–2 weeks |
| 2 — Safe UX | M2 | Automatic sidebar with no token in model history | 3–5 days |
| 3 — Policy | M3 | Approved, narrowing run rules with durable refusals | 1–2 weeks |
| 4 — Reporting | M4 | Idempotent per-session, code-free report generation | 1–2 weeks |
| 5 — Console | M5 + M6 | Locked read-only mode and offline uv provisioning | 1–2 weeks |
| 6 — Release | M7 | Threat review, compatibility CI, OTX E2E, v1.0 | 3–5 days |

These are engineering estimates, not commitments. M1 and M2 can run in parallel; integration and internal security review time is not included.

## Acceptance scenarios

Before an internal rollout, the following scenarios must pass end to end:

1. **Approval gate:** an agent attempts `emit_otx` before approval, receives the configured refusal, the event is durable, and the same call succeeds only after approval if deployment policy permits it.
2. **No token leakage:** a full session opens marimo automatically; neither the trajectory, prompt, tool result, report, nor telemetry payload contains the marimo access token.
3. **Policy narrowing:** approved rules deny `replay_tx_only`; an attempt is refused. A rule attempting to enable `bash` is rejected during approval.
4. **Limit enforcement:** two permitted replays run, the third is refused, and resume does not reset the counter.
5. **Automatic report:** `finalize_run` creates exactly one report even across process restart; report claims trace to session events and supplied OTX artifacts.
6. **Locked console:** no marimo code-mode tools are registered, no editable notebook endpoint is exposed, and the profile checker accepts the composition.
7. **Offline uv:** a clean, disconnected bench machine provisions from the shipped wheel/cache bundle and produces a report.

## Milestone 7 — Hardening and release

- [ ] Threat model document covering token flow, template trust, policy intersection, and refusal auditing.
- [ ] CI matrix across supported DSH versions.
- [ ] End-to-end test in a disposable OTX-like profile: plan gate → approval → rules → finalize → report.
- [ ] Publish `v1.0.0`.

## Dependency order

```text
M0 baseline
 ├── M1 plan gate ──── M3 run rules ──┐
 ├── M2 secure sidebar                ├── M5 locked console ── M7 release
 └── M4 automatic report ─────────────┘
M6 offline uv (independent, needed before bench/Podman rollout)
```

M1 and M2 can proceed in parallel. M3 needs M1. M5 needs M2, M3, and M4. M6 can start at any time.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| DSH pre-release APIs change | Exact internal peer pins, compatibility CI, one tested release line at a time |
| Approval state diverges after resume/fork | Derive it solely from durable events; add replay and fork tests |
| Tool alias or wildcard bypasses policy | Enforce against canonical registry names at dispatch, including PTC sub-dispatches |
| Token leaks through layout persistence or logs | Resolve at open time; automated secret scan across trajectory and artifacts |
| Report trigger runs twice | Idempotency key over session, trigger sequence, and template version |
| Trusted template becomes an execution escape | Deployment-owned immutable paths, checksum/version in report provenance, no agent-authored templates |
| Offline wheel set misses a platform artifact | Build and test wheel/cache bundles per supported OS/architecture |
| Free-text rules appear enforced | Separate enforced fields from advisory notes in schema and report UI |

## Out of scope

- Alternative Python installers or system-Python runtime providers.
- Letting session rules widen deployment permissions.
- Agent-authored reports in the locked console.
