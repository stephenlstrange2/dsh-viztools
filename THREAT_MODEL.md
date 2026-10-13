# Threat model

## Scope

This document covers `dsh-viztools` in a locked internal console using `mode: managed-readonly`. It does not claim that editable developer mode is safe for locked profiles.

## Trust boundaries

### Deployment-owned and trusted

- The DSH profile and its deployment tool policy.
- The `dsh-viztools` package and exact DSH peer versions.
- uv and the pinned Python/marimo environment.
- Report templates configured by the deployment or bundled with the plugin.
- Paths explicitly configured as report extra inputs.

A trusted template executes Python as the console operating-system user. Managed-readonly prevents the **agent** from authoring or editing that Python; it does not sandbox a malicious deployment template. Template review, immutable deployment paths, versioning, and supply-chain controls are required.

### Untrusted

- Model output and tool arguments.
- Session plan prose and advisory run-rule notes.
- Notebook/report data loaded from run artifacts.
- Browser requests without an authenticated DSH session.

## Security properties

- `managed-readonly` starts `marimo run`, never `marimo edit`.
- Notebook source is not sent to the browser (`--no-include-code`).
- Detailed Python tracebacks are not shown in the browser.
- Code-mode MCP is forcibly absent and the marimo MCP bridge is not registered.
- Model-facing `marimo_status`, `marimo_export_html`, and notebook skills are not registered.
- Locked mode serves only the bundled viewer app, pinned to its real path inside the package; runtime never creates a starter notebook in locked mode. The viewer reads only `<managedReportRoot>/<session>/` and `<gateStateDir>/<session>.status.json`, after validating the session id as one safe path segment.
- The report service, not the agent, copies a trusted template and executes/export it.
- The random marimo token travels only through DSH's authenticated Host-to-Client route and is not returned to the model.
- Plan/run policy can only narrow deployment permissions. Saved rules that no longer fit the deployment fail closed (every governed tool refused); they never fall back to the deployment allowlist.
- Gate decisions are made per call by a monotonic guard. The final refusal is persisted once, when the decision is made.
- Gate and report state never enter `session.jsonl` as custom event types (DSH 0.2.0-rc.2 cannot reopen such logs). State lives in a 0600, fsync'd, hash-chained sidecar, or in ignorable plugin records when DSH supports them. Missing, truncated, or edited state fails closed: no plan approval, saved rules refused, and limited tools refused for the session.

## The PTC transport (`run_code`)

`run_code` is not a harmless planning transport. Its program runs with Node APIs (`fs`, `net`, `child_process`) that only the DSH file and network sandbox limits. Nested tool calls inside it are guarded one by one, but the program itself can act directly. Under `danger-full-access`, allowing it before approval would bypass plan-first and run rules entirely.

The gate therefore treats `run_code` like any governed tool:

- **before plan approval**, it is refused unless the deployment sets `planFirst.allowPtcTransport: true` **and** the session's latest `sandbox/mode` is confined (`read-only` or `workspace-write`). An unknown mode or `danger-full-access` is refused;
- **after approval**, it must be in `runRules.allowedTools` (when run rules are enabled) and pass the session rules, like any other tool.

Residual risk: with the opt-in, a `run_code` program can still do whatever the confined sandbox allows (for example, read workspace files) before the plan is approved. Opt in only when that is acceptable.

## Delegation

A child agent (`subagent`, `subagent_fork`, `workflow`) would otherwise get its own fresh gate and counts, escaping the parent's approval and limits. Delegation is refused whenever the gate is active, unless the deployment sets `delegation.allow: true`. With the opt-in, a child created by an allowed delegation call shares the parent's gate: the same approval, rules, and counts. A delegated agent that cannot be attached to a governed parent has its limited tools refused.

## Residual risks

- Trusted templates have the console user's filesystem/network authority.
- marimo and template dependencies are part of the trusted computing base.
- The Browser layout may retain a tokenized loopback URL until process exit; the token is random and expires with the marimo process.
- A compromised DSH Client with an authenticated browser session can request the marimo URL.
- Report data may contain sensitive run content; artifact access control remains the deployment's responsibility.

## Required profile checks

An internal `check-dsh-profile.py` should reject the console profile unless:

1. runtime config has `mode: managed-readonly`;
2. `mcpCodeMode` is explicitly `false`;
3. `notebook` resolves below `managedReportRoot`;
4. the editable runtime entry is not duplicated elsewhere;
5. report templates resolve to deployment-controlled paths;
6. `tool-skill` and other arbitrary notebook/code execution tools remain absent unless separately justified;
7. exact supported DSH/plugin versions are pinned;
8. `planFirst.allowPtcTransport` is `false`, or it is justified together with a confined file policy;
9. `delegation.allow` is `false`, or it is justified;
10. the gate's `stateDir`, the report's `gateStateDir`, and the runtime's `gateStateDir` agree, and the console always starts from the same workspace.

The package exports `checkLockedProfile()` from `dsh-viztools/profile-check` for the first three checks. The remaining checks require inspection of the complete composed profile and belong in the internal profile checker.
