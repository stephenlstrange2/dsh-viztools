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
- Gate and report state never enter `session.jsonl` as custom event types (DSH 0.2.0-rc.2 cannot reopen such logs). State lives in a 0600, fsync'd sidecar under the workspace, or in ignorable plugin records when DSH supports them.
- **Sidecar integrity is keyed and anchored outside the workspace.** Each record carries an HMAC-SHA256 over its fields, chained to the previous record's MAC. The key is `<keyDir>/sidecar.key` (0600; `keyDir` defaults to `$DSH_HOME/viztools`, and a `keyDir` inside the workspace is rejected at startup). A MAC'd anchor in `<keyDir>/anchors/` records each session's last record index, its MAC, and fork lineage, and is replaced atomically after every append. A process that can write the workspace but not `keyDir` therefore cannot append a forged record, edit or reorder records, delete the sidecar, or truncate whole records from the tail without detection. Detected damage fails closed: no plan approval, saved rules refused until re-approved, and limited tools refused for the session. A torn final line (a crash mid-write) is ignored, because records are anchored only after they are durable.
- *Correction:* the hash chain shipped in `a751b39` was **unkeyed**. Anyone with workspace write could recompute it to append forged records (for example, a plan approval), and drop whole records from the tail undetected. The claim that edited state failed closed was wrong for that version.
- Forks inherit their parent's records up to the fork point, recursively through grandchildren. The lineage is recorded in the anchor, so a fork's inherited approval and counts are honoured rather than treated as missing state.

## The PTC transport (`run_code`)

`run_code` is not a harmless planning transport. Its program runs with Node APIs (`fs`, `net`, `child_process`) that only the DSH file and network sandbox limits. Nested tool calls inside it are guarded one by one, but the program itself can act directly. Under `danger-full-access`, allowing it before approval would bypass plan-first and run rules entirely.

The gate therefore treats `run_code` like any governed tool:

- **before plan approval**, it is refused unless the deployment sets `planFirst.allowPtcTransport: true` **and** the session's effective file policy is confined (`read-only` or `workspace-write`). The effective policy is the session's latest `sandbox/mode` override, or else the deployment default from `ctx.sandboxPolicy`. An unknown mode or `danger-full-access` is refused. Even with the opt-in, `run_code` must be in `runRules.allowedTools`, and it is refused while saved rules are invalid;
- **after approval**, it must be in `runRules.allowedTools` (when run rules are enabled) and pass the session rules, like any other tool.

Residual risk: with the opt-in, a `run_code` program can still do whatever the confined sandbox allows (for example, read workspace files) before the plan is approved. Opt in only when that is acceptable.

## Delegation

A child agent (`subagent`, `subagent_fork`, `workflow`) would otherwise get its own fresh gate and counts, escaping the parent's approval and limits. Delegation is refused whenever the gate is active, unless the deployment sets `delegation.allow: true`. With the opt-in, a child created by an allowed delegation call shares the parent's gate: the same approval, rules, and counts. A delegated agent that cannot be attached to a governed parent has its limited tools refused.

## Residual risks

- The keyed chain protects against writers confined to the workspace (for example, an agent under `workspace-write`). It does not protect against the console OS user, or against an agent running under `danger-full-access`, which can read the key. Keep `keyDir` outside every path the agent's sandbox may write.

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
10. the gate's `stateDir`, the report's `gateStateDir`, and the runtime's `gateStateDir` agree, and the console always starts from the same workspace;
11. the gate's and the report's `keyDir` (default `$DSH_HOME/viztools`) are the same and lie outside every path the agent's sandbox can write.

The package exports `checkLockedProfile()` from `dsh-viztools/profile-check` for the first three checks. The remaining checks require inspection of the complete composed profile and belong in the internal profile checker.
