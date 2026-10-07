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
- The served notebook must already exist below `managedReportRoot`; runtime never creates a starter notebook in locked mode.
- The report service, not the agent, copies a trusted template and executes/export it.
- The random marimo token travels only through DSH's authenticated Host-to-Client route and is not returned to the model.
- Plan/run policy can only narrow deployment permissions.

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
7. exact supported DSH/plugin versions are pinned.

The package exports `checkLockedProfile()` from `dsh-viztools/profile-check` for the first three checks. The remaining checks require inspection of the complete composed profile and belong in the internal profile checker.
