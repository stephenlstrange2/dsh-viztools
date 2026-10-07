import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEventMap } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { mkdir, copyFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import z from '@deepseek-ai/schemastery'
import { completedReportKeys, reportKey, REPORT_EVENT, type ReportChange } from './report-domain.js'

export { completedReportKeys, reportKey, REPORT_EVENT } from './report-domain.js'
export type { ReportChange } from './report-domain.js'

export const name = 'dsh-viztools-report'
export const inject = ['sessionPersistence']

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_TEMPLATE = join(PACKAGE_ROOT, 'python', 'dsh_viztools', 'report_template.py')

export interface Config {
  enabled?: boolean
  cwd?: string
  triggerTools?: string[]
  triggerOnTurnStop?: boolean
  template?: string
  templateVersion?: string
  outputDir?: string
  includeCode?: boolean
  environmentDir?: string
  extraInputs?: Record<string, string>
}

export interface ResolvedConfig {
  enabled: boolean
  cwd: string
  triggerTools: string[]
  triggerOnTurnStop: boolean
  template: string
  templateVersion: string
  outputDir: string
  includeCode: boolean
  environmentDir: string
  extraInputs: Record<string, string>
}

export const Config: z<Config, ResolvedConfig> = z.object({
  enabled: z.boolean().default(false),
  cwd: z.string().default(''),
  triggerTools: z.array(String).default([]),
  triggerOnTurnStop: z.boolean().default(false),
  template: z.string().default(''),
  templateVersion: z.string().default('1'),
  outputDir: z.string().default('.dsh/reports'),
  includeCode: z.boolean().default(false),
  environmentDir: z.string().default('.dsh/marimo'),
  extraInputs: z.dict(String).default({}),
})

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'viztools-report/change': ReportChange
  }
}

function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function safePath(root: string, value: string, label: string): string {
  const result = resolve(root, value)
  if (!within(root, result)) throw new Error(`${label} must stay inside the workspace: ${result}`)
  return result
}

function python(environmentDir: string): string {
  return process.platform === 'win32' ? join(environmentDir, '.venv', 'Scripts', 'python.exe') : join(environmentDir, '.venv', 'bin', 'python')
}

async function command(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(executable, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    const stderr: Buffer[] = []
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolvePromise() : reject(new Error(Buffer.concat(stderr).toString('utf8').trim() || `report export exited ${code}`)))
  })
}

export async function resolveTrajectoryPath(persistence: SessionPersistence, agent: Agent): Promise<string> {
  await persistence.flush()
  const backend = persistence as SessionPersistence & { resolveCurrentLog?(id: Agent['id']): Promise<string | undefined> }
  const path = await backend.resolveCurrentLog?.(agent.id)
  if (path === undefined) throw new Error('the configured session persistence backend does not expose the current trajectory path')
  return path
}

function append(agent: Agent, change: ReportChange): void {
  agent.session.append(REPORT_EVENT, change as SessionEventMap[typeof REPORT_EVENT])
}

/** Plugin-owned report generator, independent of agent skills and marimo code-mode MCP. */
export function apply(ctx: Context, config: ResolvedConfig): void {
  if (!config.enabled) return
  const cwd = resolve(config.cwd || process.cwd())
  const outputRoot = safePath(cwd, config.outputDir, 'report outputDir')
  const environmentDir = safePath(cwd, config.environmentDir, 'report environmentDir')
  const template = config.template === '' ? DEFAULT_TEMPLATE : safePath(cwd, config.template, 'report template')
  const inFlight = new Map<string, Promise<void>>()

  const generate = (agent: Agent, triggerSeq: number, trigger: string): Promise<void> => {
    const key = reportKey(String(agent.id), triggerSeq, config.templateVersion)
    if (completedReportKeys(agent.session.snapshotEvents(), String(agent.id)).has(key)) return Promise.resolve()
    const existing = inFlight.get(key)
    if (existing !== undefined) return existing
    const work = (async () => {
      const directory = join(outputRoot, String(agent.id))
      const notebook = join(directory, 'report.py')
      const html = join(directory, 'report.html')
      const inputsPath = join(directory, 'inputs.json')
      try {
        const trajectory = await resolveTrajectoryPath(ctx.sessionPersistence, agent)
        const extras: Record<string, string> = {}
        for (const [name, value] of Object.entries(config.extraInputs)) extras[name] = safePath(cwd, value, `report extra input ${name}`)
        await mkdir(directory, { recursive: true })
        await copyFile(template, notebook)
        await writeFile(inputsPath, JSON.stringify({ sessionId: String(agent.id), trigger, triggerSeq, trajectory, extras }, null, 2), 'utf8')
        const pythonPath = join(PACKAGE_ROOT, 'python')
        await command(python(environmentDir), [
          '-m', 'marimo', 'export', 'html', notebook, '--force', config.includeCode ? '--include-code' : '--no-include-code', '-o', html,
        ], cwd, { PYTHONPATH: process.env.PYTHONPATH ? `${pythonPath}${process.platform === 'win32' ? ';' : ':'}${process.env.PYTHONPATH}` : pythonPath })
        append(agent, { kind: 'available', version: 1, triggerSeq, trigger, templateVersion: config.templateVersion, notebook, html, inputs: inputsPath })
      } catch (error) {
        append(agent, { kind: 'failed', version: 1, triggerSeq, trigger, templateVersion: config.templateVersion, reason: error instanceof Error ? error.message : String(error) })
      }
    })().finally(() => inFlight.delete(key))
    inFlight.set(key, work)
    return work
  }

  ctx.on('tools/result', (exec) => {
    const agent = exec.agent
    if (agent === undefined || !config.triggerTools.includes(exec.name)) return
    const event = [...agent.session.snapshotEvents()].reverse().find((candidate) => candidate.type === 'tool/result' && String((candidate.data as Record<string, unknown>).message ?? '').length >= 0)
    const triggerSeq = event === undefined ? Number(agent.session.seq) - 1 : Number(event.seq)
    void generate(agent, triggerSeq, `tool:${exec.name}`)
  })

  if (config.triggerOnTurnStop) {
    ctx.on('agent/turn-stopping', async ({ agent, turn }) => {
      await generate(agent, Number(agent.session.seq), `turn:${turn}`)
    })
  }
}

apply.Config = Config
