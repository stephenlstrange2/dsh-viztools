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

Transport: a `propose_run_rules` tool with a typed schema and a dedicated human approval review. The canonical durable value is structured JSON; plan prose may describe the same rules, but Markdown is never parsed as authorization policy.

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

- [x] Effective policy = deployment policy ∩ approved rules. Never a union.
- [x] Reject rules that name a tool outside the deployment's allowed set (a user can deny `replay_tx_only`, but can never enable `bash` in the console).
- [x] Cap numeric limits at the deployment-configured maximum (`OTX_MAX_REPLAYS` maps into `runRules.maxLimits` in OTX).
- [x] Enforce allow/deny and counts at the shared `tools/pre-execute` boundary, covering native and PTC calls; reconstruct counters from durable tool events on resume.
- [x] Inject free-text `notes` as scoped prompt text explicitly labelled **advisory; not mechanically enforced**.
- [x] Persist versioned approved, refused-call, and limit-reached changes in `viztools-run-rules/change` events.
- [x] Extend `explain_plan()` with a "rules vs. what happened" table:

  | Rule | Enforcement | Observed |
  |---|---|---|
  | deny `emit_otx` | enforced | 1 refused call |
  | max `replay_tx_only` = 2 | enforced | 2 allowed, 1 refused |
  | no edits after step 40 | advisory | not verified |

Tests cover widening attempts, bad/above-cap limits, exact and prefix matching, deny precedence, durable native/PTC counters, refusal folds, and report projection.

Exit criteria: an OTX session with approved rules shows enforced refusals in both the trajectory and the report.

**Milestone status: implementation complete (2026-10-06).** Typed approval, narrowing validation, native/PTC enforcement, durable counters/refusals, advisory prompt notes, and report projection are implemented and verified. The final OTX-only acceptance screenshot is deferred to the internal profile because public fixtures do not contain OTX tools; no non-evidentiary screenshot is added.

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

- [x] Resolve the current session's trajectory path through the JSONL persistence backend after a durability flush, never by guessing its directory layout.
- [x] One notebook and export per session: `.dsh/reports/<session-id>/report.py`, `inputs.json`, and `report.html`.
- [x] Trigger after a configured terminal tool result or at `agent/turn-stopping`.
- [x] Make generation idempotent on `(session id, trigger seq, template version)` and deduplicate in-flight generation.
- [x] Let profiles supply a trusted template; pass trajectory, trigger, session identity, and extra artifact paths through structured JSON rather than generated code.
- [x] Export without code using marimo `--no-include-code --force` for the pinned version.
- [x] Record durable `available` or `failed` outcomes with artifact paths/reason. Transcript deliverable presentation remains a Client/report-card follow-up; the files and durable event are available now.
- [x] Do not depend on `tool-skill`; report generation is entirely plugin-owned.
- [x] Ship a default template using the session, plan, tool, and approved-run-rule loaders.

Tests cover stable idempotency keys, settled available/failed outcomes across replay, template-version regeneration, and durable failure evidence. A real compressed session exported successfully to a 69 KB code-free HTML report, and source-import text was absent from the artifact.

Exit criteria: finishing an OTX run produces a code-free HTML report linked in the final turn with no agent tool calls involved.

**Milestone status: implementation complete (2026-10-06).** Plugin-owned generation, per-session artifacts, trusted templates, structured inputs, both trigger paths, no-code export, and durable success/failure evidence are implemented and verified. The automatic final-turn deliverable card is deferred to the internal UI integration because this package currently records the report artifact rather than registering a custom transcript presenter. The attempted `file://` screenshot rendered blank in headless Chromium, so it was removed as non-evidence.

## Milestone 5 — Locked-console mode

Goal: the plugin can pass `check-dsh-profile.py` in the OTX console.

```yaml
- id: dsh-viztools
  config:
    mode: managed-readonly
```

In `managed-readonly`:

- [x] `mcpCodeMode` is forced off and the marimo MCP bridge is not registered.
- [x] No model-facing marimo status/export tools or notebook skills are registered.
- [x] The served notebook must already exist below `managedReportRoot`; runtime never creates a starter notebook in locked mode.
- [x] Notebook creation and export are owned by the trusted report service rather than the agent.
- [x] marimo runs in `marimo run` app mode, omits source code, and hides detailed tracebacks.
- [x] Document in `THREAT_MODEL.md` that trusted templates still execute as the console user.
- [x] Export `checkLockedProfile()` for mode, MCP, and managed-report-root checks; document the complete-composition checks required in internal `check-dsh-profile.py`.

Exit criteria: profile checker accepts the console profile; the agent has no path to execute new Python.

**Milestone status: implementation complete (2026-10-06).** A disposable managed-readonly profile booted successfully; the served app used a report-owned notebook, initial HTML contained no source marker, and `/mcp/server` returned HTTP 404. The internal `check-dsh-profile.py` repository is not available here, so its integration is documented and supported by the exported checker rather than modified directly.

## Milestone 6 — Offline installs with uv

Goal: bench PCs and the Phase F Podman bundle install without PyPI, while uv remains the only supported installer.

- [x] Add config for uv offline/cache/index sources:

  ```yaml
  uv:
    command: uv
    indexUrl: file:///opt/dsh-viztools/wheels   # or an internal mirror
    offline: true
    cacheDir: /opt/dsh-viztools/uv-cache
    pythonInstallDir: /opt/dsh-viztools/python
  ```

- [x] Pass these through as `--offline`, `--no-index`, `--find-links`/`--default-index`, `UV_CACHE_DIR`, and `UV_PYTHON_INSTALL_DIR`.
- [x] Add `pnpm run wheelhouse` to populate a portable uv cache and verify the hashed lock installs with `UV_OFFLINE=1`.
- [x] Add `python/requirements.lock` containing the complete pinned environment and SHA-256 hashes; runtime installs with `--require-hashes` by default.
- [x] Document bench and Podman bundles with uv plus the populated cache and optional managed-Python directory.
- [x] Startup diagnostics name uv explicitly when it is missing.
- [x] Default to uv >= 0.11.0 and fail startup when the installed version is older.

Exit criteria: a fresh bench PC with uv and no network provisions the environment from the transferred uv cache.

**Milestone status: implementation complete (2026-10-06).** Hashed lock resolution covers 46 packages for Python 3.12. The wheelhouse script performs an online cache fill followed by a clean offline reinstall as its verification step. Runtime config changes participate in the environment marker and force reprovisioning.

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

- [x] Threat model and security-review checklist cover token flow, template trust, policy intersection, refusal auditing, offline supply chain, and residual internal acceptance.
- [x] CI matrix pins Node, uv, and every supported DSH version; release workflow reruns verification before npm provenance publishing.
- [x] OTX-like durable lifecycle test covers closed gate → approval → narrowing rules/limit refusal → terminal report → locked-profile validation.
- [ ] Publish `v1.0.0` only after the manual/internal items in `SECURITY_REVIEW.md` are signed off. Publishing is intentionally not performed by this milestone implementation.

**Milestone status revised: OTX release blocked (2026-10-09).** CI and release infrastructure remain useful, but the architecture review identified critical enforcement and reporting gaps not exercised by the earlier fold-only lifecycle fixture. Phase 0 now freezes those gaps as explicit todo acceptance contracts in `test/otx-hardening.todo.test.ts`. Package version remains `0.1.0`; v1 is prohibited until Phases 1–8 in `SECURITY_REVIEW.md` are green and internal acceptance is signed off.

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
