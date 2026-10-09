# Changelog

All notable project changes are recorded here by roadmap milestone.

## Unreleased

### Security — OTX hardening Phase 2

- Versioned approved rules now merge monotonically: allow intersection, deny union, minimum limits, and deduplicated advisory notes.
- Added durable `accepted-call` events so live and resumed limit counts use the same fold and refused calls do not consume limits.
- Persisted a deployment-policy fingerprint and invalidate saved rules that cannot survive a stricter deployment.
- Explicitly deny subagent, fork, and workflow delegation while approved OTX rules govern the session.
- Reduced outstanding OTX blockers from 16 to 12.

### Security — OTX hardening Phase 1

- Moved authoritative plan/run denial into `ToolRuntime.guard`, which remains monotonic after earlier `allow` or `ask` listeners.
- Added fail-closed unknown-agent decisions, deployment allowlist enforcement without session rules, and deployment default limits.
- Expand wildcard proposals against the full registry and reject patterns overlapping deployment-denied tools.
- Reduced OTX release blockers from 22 to 16 with real ToolRuntime listener-order tests.

### Security — OTX hardening baseline

- Blocked v1 and locked-console promotion after architecture review found bypassable listener ordering, incomplete deployment-policy enforcement, replay-unstable counters, premature terminal reports, missing locked report publication, and runtime secret/path/privacy gaps.
- Added representative OTX terminal-result, PTC, and gate fixtures.
- Added named todo acceptance contracts for remediation Phases 1–8 while keeping the normal developer suite green.
- Explicitly retained regression coverage for the modern `tool-result` content-block loader shape used by real OTX trajectories.

### Fixed

- Load the sidebar Client through a dedicated `dsh-viztools-client-host` package boundary with matching module identity; the previous runtime-only entry never entered the Web boot graph, so automatic side-by-side opening could not run.
- Treat the `marimo_status.notebook` value as authoritative in both notebook skills, prohibit subagents from mutating the shared notebook, and require failed writes, kernel checks, and exports to be repaired before success is claimed.
- Reopen the Browser tab when the marimo runtime identity changes, avoiding stale tabs after a DSH or marimo restart.
- Resolve the default hashed Python requirements file relative to the installed `dsh-viztools` package instead of the DSH process working directory. This fixes activation from workspaces such as `~/d` where `python/requirements.lock` does not exist.

### Milestone 7 — Hardening and v1 release preparation

- Added CI for the supported Node, uv, and DSH compatibility matrix.
- Added an npm provenance release workflow gated by full verification and tag/version matching.
- Added `verify:release` checks for exact DSH peers, required exports, and packaged security documents.
- Added an OTX-like durable lifecycle test covering plan approval, rule narrowing/limit evidence, terminal report settlement, and locked-profile validation.
- Added a formal security-review checklist separating automated evidence from internal manual acceptance.
- Updated the compatibility matrix with the v1 release-candidate state.

No publish or version bump was performed. Package version remains `0.1.0` until internal OTX/profile-checker/Podman/template/retention items in `SECURITY_REVIEW.md` are signed off.

### Milestone 6 — Offline installs with uv

- Kept uv as the required and sole Python environment manager.
- Added minimum-version and missing-command diagnostics.
- Added offline, index, local-link, cache, and uv-managed Python directory configuration.
- Added a complete Python 3.12 dependency lock with SHA-256 hashes and mandatory hash verification.
- Added `pnpm run wheelhouse` to populate and then verify a portable uv cache offline.
- Documented bench and Podman deployment.

Verification: the lock resolves 46 packages; the provisioning command uses `--require-hashes`; uv 0.11.24 passes the default >=0.11.0 requirement. No screenshot is included because package provisioning has no useful UI result.

### Milestone 5 — Locked-console managed-readonly mode

- Added `mode: managed-readonly` to the runtime.
- Runs marimo as a read-only app rather than an editor and omits source code and detailed tracebacks.
- Forcibly omits code-mode MCP, the MCP client bridge, model-facing marimo tools, and notebook skills.
- Requires an existing report-service-generated notebook below `managedReportRoot`.
- Added exported `checkLockedProfile()` validation and a documented complete-profile checker contract.
- Added `THREAT_MODEL.md` covering trusted templates and residual risk.

Verification: 29 Vitest tests and 9 Python tests passed. A disposable managed-readonly profile booted, served the trusted report notebook, omitted a source marker from initial HTML, and returned HTTP 404 for `/mcp/server`.

Security boundary: deployment-owned templates still execute Python as the console OS user. Managed-readonly prevents model-authored code; it is not a sandbox for malicious deployment templates.

### Milestone 4 — Plugin-owned automatic reports

- Added configurable terminal-tool and turn-stop report triggers.
- Added per-session notebook, structured input, and HTML paths under `.dsh/reports/<session-id>/`.
- Resolve and flush the exact trajectory through session persistence instead of guessing storage layout.
- Added trusted profile templates and structured extra artifact paths.
- Added default code-free export using marimo `--no-include-code --force`.
- Added idempotency across resume based on session, trigger sequence, and template version, plus in-flight deduplication.
- Added durable `available` and `failed` report events.
- Shipped a default report template covering session metrics, tools, plan evidence, and run rules.

Verification: a real compressed DSH session produced a 69 KB HTML report; notebook source imports were absent from the code-free artifact. Unit tests cover successful/failed settlement and template-version idempotency.

Known limitation: durable report artifacts are recorded, but a custom final-turn deliverable card remains an internal Client integration follow-up. A headless `file://` screenshot was blank and was removed rather than presenting non-evidence.

### Milestone 3 — Approved narrowing run rules

- Added a typed `propose_run_rules` tool with explicit human approval.
- Added deployment-owned `allowedTools` and numeric `maxLimits`; approved session rules can only narrow them.
- Enforced exact/prefix allow and deny patterns plus durable per-tool limits for native and PTC calls.
- Persisted approved rules, policy refusals, and limit exhaustion as versioned session events.
- Added advisory notes to the system prompt with an explicit **not mechanically enforced** label.
- Extended `explain_plan()` with a rules-versus-execution table and refusal totals.

Security implication: a session rule cannot enable a tool outside the deployment allowlist or raise a server-owned numeric cap. Deny rules take precedence over allow rules.

Verification: wildcard and deny precedence, widening rejection, invalid cap rejection, native/PTC durable counters, refusal folds, Python report projection, TypeScript, builds, and package checks.

#### Result

No screenshot is included because the public disposable profile has no OTX tools and would not visibly demonstrate rule enforcement. A meaningful refusal/limit screenshot belongs in the internal OTX acceptance pass.

### Milestone 2 — Secure automatic sidebar

- Added an authenticated, no-store Host route for the current marimo URL.
- The Client plugin resolves that URL only after a Session is mounted and opens DSH's Browser sidebar automatically.
- Removed the secret-bearing URL from the model-facing `marimo_status` schema and result.
- Added connection-reset recovery and one-open-per-mounted-session behavior.
- Verified authenticated access succeeds, unauthenticated access returns HTTP 401, and stored workspace trajectories contain no `access_token=` value.

Security implication: the random marimo token now travels Host → authenticated Client only. It is no longer returned to the model or committed in new tool results.

Known limitation: DSH Browser layout may retain the URL locally for the process lifetime; the random token becomes invalid when the marimo process exits.

#### Result

The authenticated route and HTTP 401 rejection are verified automatically. A screenshot is intentionally omitted until a mounted-session capture visibly demonstrates the automatically opened marimo tab.

### Milestone 1 — Durable plan-first gate

Added a separate `dsh-viztools/gate` Cordis entry that:

- starts new and unapproved resumed sessions in plan mode;
- permits only configured planning tools plus `exit_plan_mode` before approval;
- denies native and nested PTC calls through the same `tools/pre-execute` policy;
- records versioned approval and refusal events in the session trajectory;
- restores approval on resume and inherits it at a fork cut;
- refuses agent activation when configured planning tools are unavailable.

Verification: 13 Vitest tests, 8 Python tests, TypeScript, host/client builds, package inspection, and an enabled disposable-profile boot.

Security note: plan mode is guidance, while the gate is enforcement. `/plan off`, a dismissed review, and **Keep planning** do not open the gate.

Known limitation: the final acceptance run with OTX-only tools must occur in the internal OTX profile.

#### Result

A dedicated gate-refusal screenshot will be added during the OTX acceptance pass, where the internal planning tools exist.

### Milestone 0 — Stabilized baseline

- Split runtime, gate, and report into independent exports.
- Documented exact pre-release DSH compatibility policy.
- Added DSH 0.2 tool-result and PTC regression coverage.
- Verified all three entries load together in a disposable profile.
