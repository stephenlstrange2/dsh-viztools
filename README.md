# dsh-viztools

`dsh-viztools` is an MIT-licensed DSH 0.2 plugin that runs one authenticated [marimo](https://marimo.io/) server per workspace, connects its code-mode MCP tools to the agent, and opens the live notebook beside chat.

The first version also includes a read-only Python loader for DSH `session.vN.jsonl[.zstd]` trajectories. A notebook can turn a real run into a timeline, tool-call table, retry view, token chart, and static HTML explanation.

## What it does

- Creates a uv-managed Python environment at `.dsh/marimo/.venv`.
- Pins marimo (`0.25.1` by default) and installs its MCP extras plus `zstandard`.
- Starts marimo on `127.0.0.1` using a free port and a fresh 256-bit token.
- Stops the child process when the Cordis plugin scope is disposed.
- Connects marimo through DSH's official `@deepseek-ai/dsh-mcp-client` bridge.
- Uses marimo's experimental hidden `--mcp=code-mode` mode so the agent can edit the notebook, not just inspect it.
- Returns the authenticated browser URL through `marimo_status`; paste/open it in DSH's existing right-sidebar Browser plugin.
- Registers `marimo_status`, `marimo_export_html`, and the `explain-with-notebook` skill.
- Adds `dsh_viztools.session.load_session()` to the notebook's Python path.

## Requirements

- DSH `0.2.0-rc.2` (the MVP pins its DSH peer packages to this exact release candidate).
- Node.js 22 or later.
- [`uv`](https://docs.astral.sh/uv/) on `PATH`.
- Network access on the first start so uv can provision Python and the pinned packages.
- A Web profile with the right-sidebar Browser. The bundled patch enables the shipped Browser entry.

## Install locally

Build the package, then link it into a disposable DSH profile:

```bash
pnpm install
pnpm check

dsh rescue --from-default-profile web --dump-config >/dev/null
dsh plugin --profile rescue link "$PWD"
dsh rescue
```

Use a test profile first. The plugin does not modify your active Web profile unless you explicitly install it there.

For a published package:

```bash
dsh plugin --profile rescue add dsh-viztools
dsh rescue
```

On first boot, environment setup can take a minute. Ask the agent to call `marimo_status`, then open its loopback URL in the right-sidebar Browser.

## Configuration

The bundle adds this entry:

```yaml
- id: dsh-viztools
  name: dsh-viztools
```

Override it in the profile's `cordis.patch.yml`:

```yaml
- id: dsh-viztools
  config:
    notebook: .dsh/notebooks/explanation.py
    environmentDir: .dsh/marimo
    pythonVersion: '3.12'
    marimoVersion: 0.25.1
    mcpCodeMode: true
    autoOpen: true
    exportPath: .dsh/notebooks/explanation.html
    startupTimeoutMs: 180000
```

| Setting | Default | Meaning |
|---|---|---|
| `cwd` | DSH process CWD | Workspace root. An empty value resolves to `process.cwd()` at activation. |
| `notebook` | `.dsh/notebooks/explanation.py` | Managed notebook, constrained to the workspace. |
| `environmentDir` | `.dsh/marimo` | uv environment and version marker, constrained to the workspace. |
| `uvCommand` | `uv` | uv executable name or path. |
| `pythonVersion` | `3.12` | Python version uv provisions. |
| `marimoVersion` | `0.25.1` | Exact marimo version installed. |
| `mcpCodeMode` | `true` | Enable marimo's experimental code-editing MCP tools. |
| `autoOpen` | `true` | Reserved for a future secret-safe automatic-open bridge; ignored in this MVP. |
| `exportPath` | `.dsh/notebooks/explanation.html` | Default static export destination. |
| `startupTimeoutMs` | `180000` | Setup and readiness timeout. |

The notebook, environment, and export path are rejected if they lexically escape the workspace. The notebook parent is also checked after symlink resolution before marimo starts.

## Explain a DSH session

In a notebook cell:

```python
from dsh_viztools.session import load_session

run = load_session("/path/to/session.v4.jsonl.zstd")
run.summary
```

Useful values:

- `run.header`: physical session header.
- `run.events`: complete decoded event records.
- `run.timeline`: one normalized row per event.
- `run.tool_calls`: calls paired with their results and durations.
- `run.summary`: event, turn, tool failure, retry, and token totals.
- `run.to_polars("timeline")`: optional Polars DataFrame when `polars` is installed in the notebook.

The loader supports plaintext JSONL and concatenated Zstandard frames. It never migrates or writes the source trajectory. It intentionally preserves raw records alongside normalized rows so notebook claims remain traceable.

Ask DSH to load the `explain-with-notebook` skill, point it at a trajectory, and finish by calling `marimo_export_html`.

## Security model

A marimo code-mode notebook executes arbitrary Python with the same operating-system authority as the DSH process. Treat it as shell-equivalent.

This MVP reduces accidental exposure but is **not a sandbox**:

- marimo binds only to `127.0.0.1`;
- every activation gets a random token;
- `marimo_status` returns the tokenized loopback URL to the model so it can hand the link to the user; treat the URL as a short-lived local secret;
- DSH's Browser layout may retain that URL locally, but its random token becomes useless when this plugin process stops;
- managed paths stay in the workspace;
- model tool calls still traverse DSH's normal tool policy and approval pipeline;
- the browser iframe uses DSH's existing sandbox, including `allow-same-origin` and WebSocket support.

Do not install editable mode in a locked production/OTX console. A later read-only profile should run existing notebooks without code-mode MCP and expose only read operations.

## Current limitations

- marimo's code-mode MCP flag is experimental and hidden in marimo 0.25.1; an upstream change may require a plugin update.
- Environment installation happens during plugin activation and requires network access on the first run.
- This MVP manages one notebook/server per plugin instance (normally one per workspace process).
- The trajectory loader normalizes core message/tool/token fields defensively; plugin-defined events remain available in `run.events` but may not receive specialized columns.
- Automatic sidebar opening is deferred: DSH 0.2 does not currently expose a secret-bearing Host-to-Client configuration seam suitable for the random token. The agent returns the URL instead.
- Sidebar viewing depends on DSH's Browser plugin and therefore on iframe/WebSocket compatibility in the installed DSH build.
- `polars` is not installed by default; use Python lists, marimo tables, or install it in the notebook environment.

## Development

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm pack --dry-run
```

Python loader tests run with the system Python and do not require marimo. The live smoke test provisions the uv environment and should be run explicitly against a disposable DSH profile.

## License

MIT. marimo is Apache-2.0 and is installed as a runtime dependency in the workspace-local Python environment; its source is not vendored here.
