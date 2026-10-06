import type { Context } from '@deepseek-ai/cordis'
import type { SkillRegistry } from '@deepseek-ai/dsh-skill'
import { apply as connectMcp } from '@deepseek-ai/dsh-mcp-client'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Config, type ResolvedConfig } from './config.js'
import { MarimoRuntime } from './runtime.js'

export { Config }
export type { Config as DshViztoolsConfig, ResolvedConfig } from './config.js'
export { MarimoRuntime, workspacePath } from './runtime.js'
export type { RuntimeStatus } from './runtime.js'

export const name = 'dsh-viztools-runtime'
export const inject = ['tools', 'skills']

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function registerTools(ctx: Context, runtime: MarimoRuntime): void {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'marimo_status',
    description: 'Get the live marimo notebook path and authenticated sidebar URL.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          notebook: { type: 'string', required: true },
          browserUrl: { type: 'string', required: true },
          port: { type: 'integer', required: true },
          marimoVersion: { type: 'string', required: true },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: `Live notebook: ${value.notebook}\nOpen in the DSH Browser sidebar: ${value.browserUrl}` }],
    },
    async execute() {
      const status = runtime.status()
      return {
        notebook: status.notebook,
        browserUrl: status.browserUrl,
        port: status.port,
        marimoVersion: status.marimoVersion,
      }
    },
  })), 'dsh-viztools.status-tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'marimo_export_html',
    description: 'Export the managed marimo notebook as a self-contained static HTML file inside the workspace.',
    parameters: {
      output: { type: 'string', description: 'Optional workspace-relative output path.' },
    },
    output: {
      schema: {
        type: 'object',
        properties: { path: { type: 'string', required: true } },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: `Exported notebook to ${value.path}` }],
    },
    timeoutMs: 180_000,
    async execute(args) {
      return { path: await runtime.exportHtml(args.output) }
    },
  })), 'dsh-viztools.export-tool')
}

function registerSkill(ctx: Context): void {
  ctx.effect(() => ctx.skills.register({
    name: 'explain-with-notebook',
    description: 'Build a traceable, interactive explanation in the live marimo notebook and export it to HTML.',
    whenToUse: 'Use for data-backed explanations, charts, timelines, or explaining a DSH session trajectory.',
    source: 'bundled',
    provider: 'dsh-viztools',
    resourceBase: { kind: 'directory', path: resolve(PACKAGE_ROOT, 'skills', 'explain-with-notebook') },
    content: `# Explain with marimo\n\nUse the live marimo code-mode MCP tools to inspect and edit the managed notebook.\n\n1. Read the source facts before editing. For a DSH trajectory, import \`dsh_viztools.session.load_session\`.\n2. Add small reactive cells: source/loading, transformations, then a flow, table, chart, or timeline.\n3. Put a short plain-language \`mo.md\` explanation next to every important result.\n4. Keep every reported number computed from source data; do not hand-copy totals.\n5. Run or inspect affected cells and fix errors.\n6. Call \`marimo_export_html\` at the end and link both the notebook source and HTML export in your reply.\n\nThe notebook executes Python with workspace-level authority. Treat code changes as shell-equivalent and stay inside the workspace.`,
  }), 'dsh-viztools.skill')

  ctx.effect(() => ctx.skills.register({
    name: 'explain-plan',
    description: 'Explain plan execution—or execution-only evidence—including native and MCP tools, failures, retries, and deviations.',
    whenToUse: 'Use after plan or Standard mode when the user wants to understand MCP/native tools, execution evidence, and optional plan comparison.',
    source: 'bundled',
    provider: 'dsh-viztools',
    resourceBase: { kind: 'directory', path: resolve(PACKAGE_ROOT, 'skills', 'explain-plan') },
    content: `# Explain a DSH plan\n\nRead the trajectory and call \`run.explain_plan()\`. Inspect \`summary.plan_source\`: submitted is durable; user-provided means approval not observed; reconstructed is not an approved plan; not-observed means produce execution-only evidence instead of stopping. A fallback may use \`plan_markdown\`, source, and \`boundary_seq\`. Show native and MCP inventory and the execution timeline. Parse \`mcp__<server>__<tool>\`, label phase matches heuristic, and never call a phase skipped merely because no tool mapped to it. Compute counts from the result and finish with \`marimo_export_html\`.`,
  }), 'dsh-viztools.explain-plan-skill')
}

/** Start one workspace-local marimo server and bridge its MCP tools into DSH. */
export async function apply(ctx: Context, config: ResolvedConfig): Promise<void> {
  const runtime = new MarimoRuntime({ ...config, cwd: config.cwd || process.cwd() })
  const status = await runtime.start()
  ctx.effect(() => () => runtime.stop(), 'dsh-viztools.marimo-runtime')

  registerTools(ctx, runtime)
  registerSkill(ctx)

  if (status.mcpUrl !== undefined) {
    await connectMcp(ctx, {
      transport: 'streamable-http',
      serverName: 'marimo',
      url: status.mcpUrl,
      headers: {},
      toolCallTimeoutMs: 60_000,
      failOnStartupError: true,
      maxInstructionBytes: 32_768,
      reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30_000, maxAttempts: 10 },
    })
  }

  ctx.logger.info(`marimo ${status.marimoVersion} is ready at 127.0.0.1:${status.port}`)
}

apply.Config = Config
