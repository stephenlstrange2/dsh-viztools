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
- **Sidecar integrity is keyed and anchored outside the workspace — and it is tamper-evident only against agents that cannot READ the key.** Each record carries an HMAC-SHA256 over its fields, bound to the session and channel that wrote it and chained to the previous record's MAC. Verification recomputes the MAC with the reader's own session id, so records copied from another session or channel fail. The key is `<keyDir>/sidecar.key`. `keyDir` defaults to `$DSH_HOME/viztools`; the directory must be 0700 and the file 0600, both owned by the console user, and `keyDir` must be outside the workspace by realpath. A group- or world-writable key directory, or one whose parent is group/other-writable without the sticky bit, is refused rather than tightened, and anchors must be regular files that you own and that are not group- or world-writable. A MAC'd anchor in `<keyDir>/anchors/` names each session's last record and its fork lineage, and is replaced atomically after every append. Record indices must strictly increase across the whole file, and a reset is accepted only at the next index, so a replay of the session's own older records (an old reset, approval, or wider rules) is detected even though every replayed record is MAC-valid. The anchored head must be the last record, or second-to-last when exactly one record follows it (a crash between the record and the anchor write). This is checked on every read, also after a reset. A writer limited to the workspace therefore cannot forge, edit, reorder, copy in, delete, or tail-truncate records without detection, and detected damage fails closed. **But DSH's file sandbox restricts writes, not reads**: `read-only` and `workspace-write` both let tool subprocesses read `$DSH_HOME`. An agent with any tool that can read files can read the key and forge valid records. Readers are therefore **deny by default**: every allowed tool (in `runRules.allowedTools`; with run rules off, every visible tool; plus `run_code` under `allowPtcTransport`) counts as a reader unless it is a gate control tool, `todo_write`, or listed in `keyProtection.safeTools`. The list is validated. The only wildcard is `mcp__<server>__*`, with an unambiguous server name (no `__`, no leading or trailing `_`). Server-scoped entries never match tools of a longer, `_`-containing server name, and generic prefixes (`b*`, `read*`) are rejected. While a reader is allowed, the gate **refuses every tool**. An invalid gate configuration also refuses every tool instead of failing to activate (fail open). This covers schema errors too: cordis gets a permissive `Config`, and the strict schema runs inside `apply`. Only sandboxed subprocess tools (`bash`, `pwsh`, `run_code`) can be cleared, by a probe through DSH's own `ctx.sandbox.confine` under the session's policy: a confined `cat` must read a control file in the workspace and fail on the key. In-process readers (`read`, `read_image`, `grep`, `glob`, `edit`, `str_replace_editor`), `read_mcp_resource`, and MCP tools run inside DSH or an MCP server, where no sandbox probe applies, so they are never cleared by a probe. On a stock DSH the probe fails, so file-reading tools and the gate are mutually exclusive. The OTX console, whose allowlist is `mcp__otx__*` plus `todo_write`, is unaffected.
- *Corrections:* the hash chain shipped in `a751b39` was **unkeyed**. Anyone with workspace write could recompute it to append forged records (for example, a plan approval) and drop whole records from the tail undetected, so the claim that edited state failed closed was wrong for that version. The keyed chain in `e27dbcf` still had four gaps:
  - records were not bound to the reader's session, so a MAC-valid record could be copied from another session;
  - after a reset the anchor head was not compared, so post-reset records could be truncated, including a narrowing rules approval;
  - any number of records beyond the anchor were accepted;
  - it was described as protecting against the agent, which is false whenever the agent can read files.

  `804fbef` still accepted a replayed copy of the session's own older reset segment appended after the head, which widened the rules again. It also used a fixed reader name list instead of deny-by-default, and a subprocess probe could clear in-process readers.
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

- The keyed chain protects only against writers that can neither read `keyDir` nor write outside the workspace. It does not protect against the console OS user, or against any agent that can read files. That second case is why the gate refuses to run alongside unconfined file-reading tools. A deployment that needs such tools must run them under a sandbox that denies reads of `keyDir`, which the probe then confirms.

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
11. the gate's and the report's `keyDir` (default `$DSH_HOME/viztools`) are the same and lie outside every path the agent's sandbox can write;
12. every allowed tool that cannot read files is listed in `keyProtection.safeTools` (for OTX: `mcp__otx__*`), and the list is justified. Subprocess readers are allowed only when the deployment's sandbox denies reads of `keyDir` and the gate's probe confirms it.

The package exports `checkLockedProfile()` from `dsh-viztools/profile-check` for the first three checks. The remaining checks require inspection of the complete composed profile and belong in the internal profile checker.
