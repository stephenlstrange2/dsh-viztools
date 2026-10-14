import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { mkdir, copyFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import z from '@deepseek-ai/schemastery'
import { completedReportKeysFromRecords, reportKey, type ReportChange } from './report-domain.js'
import { assertKeyDirOutside, defaultKeyDir, KeyNotReadyError, loadKeyring, openStateStore, type JsonValue, type Keyring, type StateStore } from './state-store.js'
import { matchTerminalResult, turnTriggerKey, type PendingTerminalTrigger } from './report-trigger.js'
import { isSafeSessionId, publishManagedState, readManagedState, REPORT_ROUTE, reportRouteUrl } from './managed-state.js'
import { serveReport } from './report-route.js'
import type {} from '@deepseek-ai/dsh-client-connection'
import { containedRealpath, extractDynamicInputs, substitutePlaceholders, type DynamicInputSpec } from './dynamic-inputs.js'

export { completedReportKeys, completedReportKeysFromRecords, reportKey, REPORT_EVENT } from './report-domain.js'
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
  dynamicInputs?: Record<string, DynamicInputSpec>
  extraInputRoot?: string
  timeoutMs?: number
  killGraceMs?: number
  stateDir?: string
  gateStateDir?: string
  keyDir?: string
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
  dynamicInputs: Record<string, DynamicInputSpec>
  extraInputRoot: string
  timeoutMs: number
  killGraceMs: number
  stateDir: string
  gateStateDir: string
  keyDir: string
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
  dynamicInputs: z.dict(z.object({ tool: z.string().required(), field: z.string().required(), pattern: z.string().required() })).default({}),
  extraInputRoot: z.string().default('.'),
  timeoutMs: z.number().min(1_000).default(120_000),
  killGraceMs: z.number().min(100).default(2_000),
  stateDir: z.string().default('.dsh/viztools/state'),
  gateStateDir: z.string().default('.dsh/viztools/state'),
  keyDir: z.string().default(''),
})

function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function safePath(root: string, value: string, label: string): string {
  const result = resolve(root, value)
  if (!within(root, result)) throw new Error(`${label} must stay inside the workspace: ${result}`)
  return result
}

async function containedExistingPath(root: string, value: string, label: string): Promise<string> {
  const trusted = await realpath(root)
  const target = await realpath(resolve(root, value))
  const rel = relative(trusted, target)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`${label} resolves outside trusted root: ${target}`)
  return target
}

function safeSessionId(value: string): string {
  if (!isSafeSessionId(value)) throw new Error(`invalid report session id: ${value}`)
  return value
}

function python(environmentDir: string): string {
  return process.platform === 'win32' ? join(environmentDir, '.venv', 'Scripts', 'python.exe') : join(environmentDir, '.venv', 'bin', 'python')
}

export async function runReportCommand(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, killGraceMs: number): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(executable, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    const stderr: Buffer[] = []
    let timedOut = false
    let killTimer: NodeJS.Timeout | undefined
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), killGraceMs)
      killTimer.unref()
    }, timeoutMs)
    timeout.unref()
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.once('error', (error) => { clearTimeout(timeout); if (killTimer !== undefined) clearTimeout(killTimer); reject(error) })
    // A timed-out export settles on 'exit' (grandchildren may hold the pipes open);
    // otherwise wait for 'close' so the captured stderr is complete.
    child.once('exit', () => {
      clearTimeout(timeout)
      if (killTimer !== undefined) clearTimeout(killTimer)
      if (timedOut) reject(new Error(`report export timed out after ${timeoutMs}ms`))
    })
    child.once('close', (code) => {
      if (timedOut) return
      if (code === 0) resolvePromise()
      else reject(new Error(Buffer.concat(stderr).toString('utf8').trim() || `report export exited ${code}`))
    })
  })
}

export async function resolveTrajectoryPath(persistence: SessionPersistence, agent: Agent): Promise<string> {
  await persistence.flush()
  const backend = persistence as SessionPersistence & { resolveCurrentLog?(id: Agent['id']): Promise<string | undefined> }
  const path = await backend.resolveCurrentLog?.(agent.id)
  if (path === undefined) throw new Error('the configured session persistence backend does not expose the current trajectory path')
  return path
}

function sidecarPath(root: string, sessionId: string, channel: 'gate' | 'report'): string {
  return join(root, `${sessionId}.${channel}.jsonl`)
}

/** Plugin-owned report generator, independent of agent skills and marimo code-mode MCP. */
export interface ReportTestHooks {
  /** Delay before retrying a report whose key was not ready (default 5 s). */
  readonly keyRetryDelayMs?: number
}

/** How many times one report is retried while the key is still being written. */
export const KEY_NOT_READY_RETRIES = 12

export function apply(ctx: Context, config: ResolvedConfig, hooks: ReportTestHooks = {}): void {
  if (!config.enabled) return
  const cwd = resolve(config.cwd || process.cwd())
  const outputRoot = safePath(cwd, config.outputDir, 'report outputDir')
  const environmentDir = safePath(cwd, config.environmentDir, 'report environmentDir')
  const templatePromise = config.template === '' ? realpath(DEFAULT_TEMPLATE) : containedExistingPath(cwd, config.template, 'report template')
  // Observed here so a bad template path fails each report (recorded as `failed`) instead of
  // surfacing as an unhandled rejection that would terminate the host.
  templatePromise.catch(() => undefined)
  const inFlight = new Map<string, Promise<void>>()
  const pending = new WeakMap<Agent, Map<string, PendingTerminalTrigger>>()
  const turnScheduled = new Set<string>()
  const stateRoot = safePath(cwd, config.stateDir, 'report stateDir')
  const gateStateRoot = safePath(cwd, config.gateStateDir, 'report gateStateDir')
  const keyDir = resolve(config.keyDir || defaultKeyDir())
  // An unusable key directory must not crash the profile; reports then fail with a notice.
  let keyFailure: string | undefined
  try { assertKeyDirOutside(keyDir, cwd) } catch (error) { keyFailure = error instanceof Error ? error.message : String(error) }
  let keyring: Keyring | undefined
  const stores = new WeakMap<Agent, StateStore>()
  /** Report outcomes live on the plugin `report` channel, never as custom session-log events. */
  const storeFor = (agent: Agent): StateStore => {
    let store = stores.get(agent)
    if (store === undefined) {
      if (keyFailure !== undefined) throw new Error(`dsh-viztools cannot use its key directory (${keyFailure})`)
      if (keyring === undefined) throw new Error('dsh-viztools report key is not loaded yet')
      store = openStateStore({ root: stateRoot, session: agent.session as never, channel: 'report', keyring })
      stores.set(agent, store)
    }
    return store
  }
  const append = (agent: Agent, change: ReportChange): void => {
    const { kind, ...data } = change
    storeFor(agent).append(kind, data as unknown as { [key: string]: JsonValue })
  }
  const report = (message: string, error: unknown): void => {
    const detail = error instanceof Error ? error.message : String(error)
    const logger = (ctx as unknown as { logger?: { warn?: (text: string) => void } }).logger
    if (typeof logger?.warn === 'function') logger.warn(`${message}: ${detail}`)
    else console.warn(`dsh-viztools-report: ${message}: ${detail}`)
  }

  const retryDelayMs = hooks.keyRetryDelayMs ?? 5_000
  /** Total time one wait may take: every attempt, sleeps included, counts against it. */
  const keyWaitWindowMs = KEY_NOT_READY_RETRIES * retryDelayMs
  const publishSafely = (sessionId: string, reason: string): void => {
    if (!isSafeSessionId(sessionId)) return
    void publishManagedState(outputRoot, { status: 'failed', sessionId, reason, updatedAt: Date.now() })
      .catch((publishError: unknown) => report(`could not publish report state for ${sessionId}`, publishError))
  }
  /** ONE shared wait for a key that another process is still writing (never blocks; resets after). */
  let keyWait: Promise<'ready' | 'gave-up'> | undefined
  const waitForKey = (): Promise<'ready' | 'gave-up'> => {
    keyWait ??= (async () => {
      const deadline = Date.now() + keyWaitWindowMs
      for (;;) {
        try {
          // A single synchronous attempt (no inner wait), so the whole window is this loop.
          keyring = loadKeyring(keyDir)
          for (const notice of keyring.notices ?? []) report('key directory', notice)
          return 'ready' as const
        } catch (error) {
          if (!(error instanceof KeyNotReadyError)) throw error
          const left = deadline - Date.now()
          if (left <= 0) return 'gave-up' as const
          await new Promise((resolveLater) => { const timer = setTimeout(resolveLater, Math.min(retryDelayMs, left)); timer.unref?.() })
        }
      }
    })().finally(() => { keyWait = undefined })
    return keyWait
  }
  /** Reports waiting for the key, by report key: concurrent triggers share one waiter. */
  const waiting = new Map<string, Promise<void>>()

  const generate = (agent: Agent, triggerSeq: number, trigger: string): Promise<void> => {
    if (keyring === undefined && keyFailure === undefined) {
      try {
        keyring = loadKeyring(keyDir)
        for (const notice of keyring.notices ?? []) report('key directory', notice)
      } catch (error) {
        if (!(error instanceof KeyNotReadyError)) {
          keyFailure = error instanceof Error ? error.message : String(error)
          return generate(agent, triggerSeq, trigger)
        }
        // Transient (the key is still being written): keep reports enabled and retry THIS report
        // once the key is ready; never disable reporting until a restart.
        const waitKey = reportKey(String(agent.id), triggerSeq, config.templateVersion)
        const already = waiting.get(waitKey)
        if (already !== undefined) return already
        const sessionId = String(agent.id)
        publishSafely(sessionId, `Report key is not ready yet; waiting up to ${Math.round(keyWaitWindowMs / 1000)} s`)
        const chain = waitForKey().then((outcome) => {
          if (outcome === 'ready') return generate(agent, triggerSeq, trigger)
          report(`report for ${sessionId} gave up waiting for the key`, `not ready after ${Math.round(keyWaitWindowMs / 1000)} s`)
          publishSafely(sessionId, `Gave up: the report key was not ready after ${Math.round(keyWaitWindowMs / 1000)} s. The next report will try again.`)
          return undefined
        }, (waitError: unknown) => {
          keyFailure = waitError instanceof Error ? waitError.message : String(waitError)
          return generate(agent, triggerSeq, trigger)
        }).finally(() => waiting.delete(waitKey))
        waiting.set(waitKey, chain)
        return chain
      }
    }
    const key = reportKey(String(agent.id), triggerSeq, config.templateVersion)
    try {
      if (completedReportKeysFromRecords(storeFor(agent).read().records, String(agent.id)).has(key)) return Promise.resolve()
    } catch (error) {
      report(`could not read report history for ${String(agent.id)}`, error)
      // Fail closed but visibly: the viewer shows why no report was produced.
      const sessionId = String(agent.id)
      if (isSafeSessionId(sessionId)) {
        void publishManagedState(outputRoot, { status: 'failed', sessionId, reason: `Report state is unavailable: ${error instanceof Error ? error.message : String(error)}`, updatedAt: Date.now() })
          .catch((publishError: unknown) => report(`could not publish failed report state for ${sessionId}`, publishError))
      }
      return Promise.resolve()
    }
    const existing = inFlight.get(key)
    if (existing !== undefined) return existing
    const work = (async () => {
      const sessionId = safeSessionId(String(agent.id))
      const directory = join(outputRoot, sessionId)
      const notebook = join(directory, 'report.py')
      const html = join(directory, 'report.html')
      const inputsPath = join(directory, 'inputs.json')
      try {
        const trajectory = await resolveTrajectoryPath(ctx.sessionPersistence, agent)
        const template = await templatePromise
        const dynamic = extractDynamicInputs(agent.session.snapshotEvents(), config.dynamicInputs)
        const extras: Record<string, string> = {}
        const inputRoot = safePath(cwd, config.extraInputRoot, 'report extraInputRoot')
        for (const [name, value] of Object.entries(config.extraInputs)) {
          const substituted = substitutePlaceholders(value, dynamic)
          extras[name] = await containedRealpath(inputRoot, substituted, `report extra input ${name}`)
        }
        await mkdir(directory, { recursive: true })
        await copyFile(template, notebook)
        const backend = storeFor(agent).backend
        // Plugin state the template reads alongside the trajectory (paths only; no secrets).
        const pluginState = backend === 'sidecar'
          ? { backend, gate: sidecarPath(gateStateRoot, sessionId, 'gate'), report: sidecarPath(stateRoot, sessionId, 'report'), status: join(gateStateRoot, `${sessionId}.status.json`) }
          : { backend, gate: null, report: null, status: join(gateStateRoot, `${sessionId}.status.json`) }
        await writeFile(inputsPath, JSON.stringify({ sessionId, trigger, triggerSeq, trajectory, dynamic, extras, pluginState }, null, 2), 'utf8')
        const pythonPath = join(PACKAGE_ROOT, 'python')
        await runReportCommand(python(environmentDir), [
          '-m', 'marimo', 'export', 'html', notebook, '--force', config.includeCode ? '--include-code' : '--no-include-code', '-o', html,
        ], cwd, { PYTHONPATH: process.env.PYTHONPATH ? `${pythonPath}${process.platform === 'win32' ? ';' : ':'}${process.env.PYTHONPATH}` : pythonPath }, config.timeoutMs, config.killGraceMs)
        await publishManagedState(outputRoot, { status: 'available', sessionId, html, url: reportRouteUrl(sessionId), updatedAt: Date.now() })
        append(agent, { kind: 'available', version: 1, triggerSeq, trigger, templateVersion: config.templateVersion, notebook, html, inputs: inputsPath })
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        await publishManagedState(outputRoot, { status: 'failed', sessionId, reason, updatedAt: Date.now() })
        append(agent, { kind: 'failed', version: 1, triggerSeq, trigger, templateVersion: config.templateVersion, reason })
      }
    })().catch((error: unknown) => {
      // Last-resort containment: report generation must never crash the host process.
      report(`report generation for ${String(agent.id)} could not be recorded`, error)
    }).finally(() => inFlight.delete(key))
    inFlight.set(key, work)
    return work
  }

  // Serve finished exports on the authenticated DSH origin whenever the web connection exists.
  // This lives with the report plugin (not the marimo runtime) so reports stay reachable even
  // if marimo is disabled or fails to start.
  ctx.inject(['connection'], (web) => {
    web.effect(() => web.connection.fetch.register({
      path: REPORT_ROUTE,
      methods: ['GET', 'HEAD'],
      requestBody: 'buffered',
      fetch: (request) => serveReport(outputRoot, request),
    }), 'dsh-viztools.report-route')
  })

  ctx.on('agent/created', ({ agent }) => {
    const sessionId = String(agent.id)
    if (!isSafeSessionId(sessionId)) return undefined
    // On resume a finished report (available or failed) must survive; only seed missing state.
    void readManagedState(outputRoot, sessionId)
      .then((existing) => existing === undefined ? publishManagedState(outputRoot, { status: 'pending', sessionId, updatedAt: Date.now() }) : undefined)
      .catch((error: unknown) => report(`could not publish pending report state for ${sessionId}`, error))
    return undefined
  })

  ctx.on('tools/result', (exec) => {
    const agent = exec.agent
    if (agent === undefined || !config.triggerTools.includes(exec.name)) return
    let calls = pending.get(agent)
    if (calls === undefined) { calls = new Map(); pending.set(agent, calls) }
    calls.set(String(exec.callId), { callId: String(exec.callId), tool: exec.name })
  })

  ctx.on('agent/created', ({ agent }) => {
    agent.ctx.on('session/event', (session, event) => {
      if (session !== agent.session) return
      const calls = pending.get(agent)
      if (calls === undefined) return
      const terminal = matchTerminalResult(event, calls)
      if (terminal === undefined) return
      calls.delete(terminal.callId)
      queueMicrotask(() => { void generate(agent, Number(event.seq), `tool:${terminal.tool}`) })
    })
    return undefined
  })

  if (config.triggerOnTurnStop) {
    ctx.on('agent/turn-stopping', ({ agent, turn }) => {
      const key = turnTriggerKey(String(agent.id), turn, config.templateVersion)
      if (turnScheduled.has(key)) return
      turnScheduled.add(key)
      queueMicrotask(() => { void generate(agent, Number(agent.session.seq), `turn:${turn}`).finally(() => turnScheduled.delete(key)) })
    })
  }
}

apply.Config = Config
