# Agent instructions

## Milestone workflow

When the user asks to implement the roadmap:

1. Work on exactly one roadmap milestone at a time.
2. Stop after that milestone is implemented and verified; do not begin the next milestone without a new user request.
3. Update `ROADMAP.md` checkboxes and add a dated milestone-status note.
4. Update `README.md` for user-facing configuration or behavior.
5. Update `CHANGELOG.md` with the milestone's behavior, tests, security implications, and known limitations.
6. Add or update a screenshot in `docs/assets/` showing the milestone result. Embed it in both `README.md` and the relevant `CHANGELOG.md` entry. Never expose live access tokens, credentials, internal hostnames, or private customer/run data in screenshots; redact or use a disposable fixture profile.
7. Run the full verification suite (`pnpm check`, Python/example syntax where applicable, `git diff --check`, `pnpm pack --dry-run`) and a disposable-profile smoke test.
8. Leave changes uncommitted unless the user explicitly asks for a commit.
9. End the milestone report with a concise suggested Conventional Commit message.

## Architectural constraints

- uv remains a required dependency and the sole supported Python environment manager.
- Enforcement must remain separate from visualization and must work with marimo disabled.
- Session policies may narrow deployment permissions only; never widen them.
- Marimo tokens must never be returned to the model or written to the trajectory.
- Locked-console reporting must be plugin-driven and must not depend on agent skills.
