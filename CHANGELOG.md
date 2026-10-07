# Changelog

All notable project changes are recorded here by roadmap milestone.

## Unreleased

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
