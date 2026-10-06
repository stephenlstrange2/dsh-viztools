import z from '@deepseek-ai/schemastery'

export interface Config {
  /** Workspace whose files the notebook may read and modify. */
  cwd?: string
  /** Notebook path, relative to cwd unless absolute. */
  notebook?: string
  /** Directory for the uv-managed Python environment, relative to cwd unless absolute. */
  environmentDir?: string
  /** uv executable. */
  uvCommand?: string
  /** Python version uv should provision. */
  pythonVersion?: string
  /** Exact marimo version installed in the environment. */
  marimoVersion?: string
  /** Start marimo's experimental code-mode MCP endpoint. */
  mcpCodeMode?: boolean
  /** Open marimo in the right sidebar when a Session is mounted. */
  autoOpen?: boolean
  /** Export destination used when the export tool omits a path. */
  exportPath?: string
  /** Time allowed for environment setup and server readiness. */
  startupTimeoutMs?: number
}

export interface ResolvedConfig {
  cwd: string
  notebook: string
  environmentDir: string
  uvCommand: string
  pythonVersion: string
  marimoVersion: string
  mcpCodeMode: boolean
  autoOpen: boolean
  exportPath: string
  startupTimeoutMs: number
}

export const Config = z.object({
  cwd: z.string().default(''),
  notebook: z.string().default('.dsh/notebooks/explanation.py'),
  environmentDir: z.string().default('.dsh/marimo'),
  uvCommand: z.string().default('uv'),
  pythonVersion: z.string().default('3.12'),
  marimoVersion: z.string().default('0.25.1'),
  mcpCodeMode: z.boolean().default(true),
  autoOpen: z.boolean().default(true),
  exportPath: z.string().default('.dsh/notebooks/explanation.html'),
  startupTimeoutMs: z.number().min(1_000).default(180_000),
})
