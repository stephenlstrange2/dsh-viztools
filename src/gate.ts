import { spawn } from 'node:child_process'
import { renameSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { EXIT_PLAN_MODE } from '@deepseek-ai/dsh-plan-mode'
import type {} from '@deepseek-ai/dsh-user-questions'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { decideTool, DELEGATION_TOOLS, expandPatterns, RUN_CODE, type GateDenial } from './gate-policy.js'
import { applyGateRecord, evaluateTrust, foldGateRecords, type GateFold, type GateRecordKind } from './gate-state.js'
import { isSafeSessionId } from './managed-state.js'
import { deploymentFingerprint, rulesValidForDeployment, RUN_RULES_VERSION, type RunRules } from './run-rules.js'
import { assertKeyDirOutside, defaultKeyDir, KeyNotReadyError, loadKeyring, loadKeyringAsync, openStateStore, type JsonValue, type Keyring, type PluginRecordApi, type StateStore } from './state-store.js'

export { GATE_EVENT_TYPE, decodeGateChange, foldGate, initialGateState } from './gate-domain.js'
export type { GateChange, GateState } from './gate-domain.js'
export { DELEGATION_TOOLS, RUN_CODE } from './gate-policy.js'

export const name = 'dsh-viztools-gate'
export const inject = ['tools', 'userQuestions', 'systemPrompt']

export const PROPOSE_RUN_RULES = 'propose_run_rules'
export const DEFAULT_STATE_DIR = '.dsh/viztools/state'

export interface PlanFirstConfig {
  enabled?: boolean
  planningTools?: string[]
  denialMessage?: string
  allowPtcTransport?: boolean
}

export interface RunRulesConfig {
  enabled?: boolean
  allowedTools?: string[]
  maxLimits?: Record<string, number>
}

export interface DelegationConfig {
  allow?: boolean
}

export interface KeyProtectionConfig {
  /** Tools that can read arbitrary files (and therefore the HMAC key). */
  /** Tools that are ALWAYS treated as file readers, even if listed in `safeTools`. */
  fileReadingTools?: string[]
  /**
   * Tools the deployment vouches cannot read files (exact names, or a `prefix*`). Every other
   * allowed tool, MCP tools included, is presumed able to read the key.
   */
  safeTools?: string[]
}

/** DSH native tools that can read files. Deployments add MCP or custom readers. */
/** Known file readers, kept for documentation and for `fileReadingTools` users; readers are now deny-by-default. */
export const DEFAULT_FILE_READING_TOOLS = ['run_code', 'bash', 'pwsh', 'read', 'read_image', 'grep', 'glob', 'edit', 'write', 'str_replace_editor', 'read_mcp_resource', 'list_mcp_resources', 'list_mcp_resource_templates']
/** Tools that never read files: the gate's own control tools and DSH's in-session todo list. */
export const BUILTIN_SAFE_TOOLS = ['exit_plan_mode', 'propose_run_rules', 'todo_write']
/**
 * Readers that run as SUBPROCESSES under DSH's sandbox, so a confinement probe can vouch for
 * them. Everything else (in-process tools such as read, read_image, grep, edit,
 * str_replace_editor; MCP tools and read_mcp_resource, which run in MCP server processes) can
 * never be cleared by a probe.
 */
export const SANDBOXED_SUBPROCESS_TOOLS = ['bash', 'pwsh', 'run_code']

/** DSH MCP server names (`dsh-mcp-client` serverName). */
const MCP_SERVER = /^[A-Za-z0-9_-]{1,32}$/

/**
 * Validate `keyProtection.safeTools`. Entries are trimmed; an empty entry, `*`, any pattern
 * that would cover every MCP tool (`mcp__*`, `mcp_*`, `m*`, ...), and partial MCP server
 * prefixes (`mcp__ot*`) are rejected. A wildcard MCP entry must be exactly `mcp__<server>__*`.
 */
export function resolveSafeTools(entries: readonly string[]): string[] {
  const out: string[] = []
  for (const raw of entries) {
    const entry = raw.trim()
    if (entry === '' || entry === '*') throw new Error(`keyProtection.safeTools entry ${JSON.stringify(raw)} is empty or matches every tool`)
    if (entry.endsWith('*')) {
      const prefix = entry.slice(0, -1)
      if (prefix.includes('*')) throw new Error(`keyProtection.safeTools entry ${JSON.stringify(raw)} may contain only one trailing *`)
      if ('mcp__'.startsWith(prefix)) throw new Error(`keyProtection.safeTools entry ${JSON.stringify(raw)} would vouch for every MCP tool; name the server: mcp__<server>__*`)
      if (prefix.startsWith('mcp__')) {
        const server = prefix.endsWith('__') ? prefix.slice('mcp__'.length, -2) : undefined
        if (server === undefined || !MCP_SERVER.test(server)) throw new Error(`keyProtection.safeTools entry ${JSON.stringify(raw)} must be exactly mcp__<server>__* (server names match [A-Za-z0-9_-]{1,32})`)
      }
    }
    if (!out.includes(entry)) out.push(entry)
  }
  return out
}

/**
 * Whether a vouched-safe pattern covers a tool. `mcp__<server>__*` matches only tools that can
 * belong to THAT server: server names may themselves contain "_" or "__", so a public name
 * whose remainder starts with "_" or contains "__" (e.g. `mcp__otx___x` from server `otx_`, or
 * `mcp__otx__evil__x` from server `otx__evil`) is ambiguous and is not matched. List such
 * tools by exact name.
 */
export function safePatternMatches(pattern: string, tool: string): boolean {
  if (!pattern.endsWith('*')) return tool === pattern
  const prefix = pattern.slice(0, -1)
  if (!tool.startsWith(prefix)) return false
  if (!prefix.startsWith('mcp__')) return true
  const rest = tool.slice(prefix.length)
  return rest.length > 0 && !rest.startsWith('_') && !rest.includes('__')
}

export interface Config {
  planFirst?: PlanFirstConfig
  runRules?: RunRulesConfig
  delegation?: DelegationConfig
  keyProtection?: KeyProtectionConfig
  cwd?: string
  stateDir?: string
  keyDir?: string
}

export interface ResolvedConfig {
  planFirst: {
    enabled: boolean
    planningTools: string[]
    denialMessage: string
    allowPtcTransport: boolean
  }
  runRules: {
    enabled: boolean
    allowedTools: string[]
    maxLimits: Record<string, number>
  }
  delegation: {
    allow: boolean
  }
  keyProtection: {
    fileReadingTools: string[]
    safeTools: string[]
  }
  cwd: string
  stateDir: string
  keyDir: string
}

export const Config: z<Config, ResolvedConfig> = z.object({
  planFirst: z.object({
    enabled: z.boolean().default(false),
    planningTools: z.array(String).default([]),
    denialMessage: z.string().default('Plan not approved yet.'),
    allowPtcTransport: z.boolean().default(false),
  }).default({}),
  runRules: z.object({
    enabled: z.boolean().default(false),
    allowedTools: z.array(String).default([]),
    maxLimits: z.dict(Number).default({}),
  }).default({}),
  delegation: z.object({
    allow: z.boolean().default(false),
  }).default({}),
  keyProtection: z.object({
    fileReadingTools: z.array(String).default([]),
    safeTools: z.array(String).default([]),
  }).default({}),
  cwd: z.string().default(''),
  stateDir: z.string().default(DEFAULT_STATE_DIR),
  keyDir: z.string().default(''),
})

interface AgentGate {
  readonly store: StateStore
  readonly sessionId: string
  fold: GateFold
  /** Set when counts for limited tools can no longer be trusted; sticky for the session. */
  countsUntrusted?: string
  /** Set when the session cannot submit a plan (plan mode unavailable). */
  planNotice?: string
  stateNotice?: string
  /** Calls that passed this guard but have not yet reached dispatch; they count against limits. */
  readonly reserved: Map<string, string>
  /** Call ids whose refusal was already persisted (or queued). */
  readonly audited: Set<string>
  /** Per-call verdicts, so a call evaluated by several guard instances gets one decision. */
  readonly verdicts: Map<string, string | undefined>
  /** Records whose durable write failed; retried before the next decision and on results. */
  readonly pending: { kind: GateRecordKind; data: { [key: string]: JsonValue } }[]
}

interface PlanModeLike {
  set(agent: Agent, active: boolean): unknown
}

/** Resolved config, or a partial one (missing keys take their defaults). */
export type GateInput = { readonly [K in keyof ResolvedConfig]?: ResolvedConfig[K] extends object ? Partial<ResolvedConfig[K]> : ResolvedConfig[K] }

function partial(config: GateInput): ResolvedConfig {
  return {
    planFirst: { enabled: false, planningTools: [], denialMessage: 'Plan not approved yet.', allowPtcTransport: false, ...config.planFirst },
    runRules: { enabled: false, allowedTools: [], maxLimits: {}, ...config.runRules },
    delegation: { allow: false, ...config.delegation },
    keyProtection: { fileReadingTools: [], safeTools: [], ...config.keyProtection },
    cwd: config.cwd ?? '',
    stateDir: config.stateDir ?? DEFAULT_STATE_DIR,
    keyDir: config.keyDir ?? '',
  }
}

export function resolveGateConfig(input: GateInput): ResolvedConfig {
  const config = partial(input)
  const tools = [...new Set(config.planFirst.planningTools.map((tool) => tool.trim()))]
  if (tools.some((tool) => tool.length === 0)) throw new Error('planFirst.planningTools entries must be non-empty')
  const denialMessage = config.planFirst.denialMessage.trim()
  if (denialMessage.length === 0) throw new Error('planFirst.denialMessage must be non-empty')
  const allowedTools = [...new Set(config.runRules.allowedTools.map((tool) => tool.trim()))]
  if (allowedTools.some((tool) => tool.length === 0)) throw new Error('runRules.allowedTools entries must be non-empty')
  for (const [tool, limit] of Object.entries(config.runRules.maxLimits)) {
    if (!allowedTools.includes(tool)) throw new Error(`runRules.maxLimits names tool outside allowedTools: ${tool}`)
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error(`runRules.maxLimits.${tool} must be a positive integer`)
  }
  if (config.planFirst.enabled && config.runRules.enabled) {
    const outside = tools.filter((tool) => !allowedTools.includes(tool))
    if (outside.length > 0) throw new Error(`planFirst.planningTools must stay inside runRules.allowedTools: ${outside.join(', ')}`)
  }
  const safeTools = resolveSafeTools(config.keyProtection.safeTools)
  const fileReadingTools = [...new Set(config.keyProtection.fileReadingTools.map((tool) => tool.trim()).filter((tool) => tool !== ''))]
  return {
    ...config,
    keyProtection: { ...config.keyProtection, safeTools, fileReadingTools },
    planFirst: { ...config.planFirst, planningTools: tools, denialMessage },
    runRules: { ...config.runRules, allowedTools, maxLimits: { ...config.runRules.maxLimits } },
  }
}

function validateRules(rules: RunRules, config: ResolvedConfig['runRules'], registryTools: string[]): RunRules {
  const grammar = /^[A-Za-z0-9_-]+(?:__[A-Za-z0-9_-]+)*(?:\*)?$/
  for (const pattern of [...(rules.allow ?? []), ...rules.deny]) {
    if (!grammar.test(pattern) || (pattern.includes('*') && !pattern.endsWith('*'))) throw new Error(`invalid tool pattern ${pattern}`)
    const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern
    if (!config.allowedTools.some((tool) => tool === prefix || tool.startsWith(prefix))) throw new Error(`rule names tool outside deployment allowed set: ${pattern}`)
  }
  const deploymentAllowed = new Set(config.allowedTools)
  const allow = rules.allow === undefined ? undefined : expandPatterns(rules.allow, registryTools, deploymentAllowed)
  const deny = expandPatterns(rules.deny, registryTools, deploymentAllowed)
  for (const [tool, limit] of Object.entries(rules.limits)) {
    const cap = config.maxLimits[tool]
    if (cap === undefined) throw new Error(`rule limit names unsupported tool: ${tool}`)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > cap) throw new Error(`rule limit for ${tool} must be between 1 and ${cap}`)
  }
  const { allow: _allow, ...rest } = rules
  return { ...rest, ...(allow === undefined ? {} : { allow }), deny, deploymentFingerprint: deploymentFingerprint(config.allowedTools, config.maxLimits) }
}

/** Resolve the plan-mode service from the gate's own scope first, then the agent's scope. */
function resolvePlanMode(ctx: Context, agent: Agent): PlanModeLike | undefined {
  const lookup = (scope: unknown): PlanModeLike | undefined => {
    try {
      const value = (scope as { get?: (name: string) => unknown }).get?.('planMode')
      return typeof value === 'object' && value !== null && typeof (value as PlanModeLike).set === 'function' ? value as PlanModeLike : undefined
    } catch {
      return undefined
    }
  }
  return lookup(ctx) ?? lookup(agent.ctx)
}

function warn(ctx: Context, message: string): void {
  const logger = (ctx as unknown as { logger?: { warn?: (text: string) => void } }).logger
  if (typeof logger?.warn === 'function') logger.warn(message)
  else console.warn(`dsh-viztools-gate: ${message}`)
}

/** Latest `sandbox/mode` recorded in the session log, if any. */
export function sessionSandboxMode(agent: Pick<Agent, 'session'>, policy?: unknown): string | undefined {
  // Preferred: DSH's own resolution (session override, else the deployment default).
  const service = policy as { resolve?: (request: { session: unknown }) => { mode?: unknown }; defaultMode?: unknown } | undefined
  if (typeof service?.resolve === 'function') {
    try {
      const mode = service.resolve({ session: agent.session }).mode
      if (typeof mode === 'string') return mode
    } catch { /* fall through to the log */ }
  }
  const events = agent.session.snapshotEvents()
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if ((event?.type as string | undefined) === 'sandbox/mode') {
      const mode = ((event as { data: unknown }).data as { mode?: unknown }).mode
      return typeof mode === 'string' ? mode : undefined
    }
  }
  // No override in the log: the deployment default applies.
  return typeof service?.defaultMode === 'string' ? service.defaultMode : undefined
}

function errorCode(result: unknown): string | undefined {
  const info = (result as { error?: { info?: { code?: unknown } } } | undefined)?.error?.info
  return typeof info?.code === 'string' ? info.code : undefined
}

export interface GateTestHooks {
  /** Force a backend in tests: a plugin-record API, or `null` for the sidecar. */
  readonly pluginRecords?: PluginRecordApi | null
}

/** Install the durable plan-first and run-rules enforcement gate. */
export function apply(ctx: Context, input: GateInput, hooks: GateTestHooks = {}): void {
  let config: ResolvedConfig
  try {
    config = resolveGateConfig(input)
  } catch (error) {
    // Throwing would leave the entry un-activated and DSH running WITHOUT the gate (fail open).
    // Refuse every tool instead, with the reason, until the configuration is fixed.
    const reason = `dsh-viztools gate configuration is invalid (${error instanceof Error ? error.message : String(error)}); every tool is refused until it is fixed`
    warn(ctx, reason)
    ctx.on('agent/created', ({ agent }) => {
      agent.ctx.effect(() => agent.ctx.tools.guard(() => reason), 'dsh-viztools.invalid-config')
      return undefined
    })
    return
  }
  if (!config.planFirst.enabled && !config.runRules.enabled) return

  const workspace = resolve(config.cwd || process.cwd())
  const stateRoot = resolve(workspace, config.stateDir)
  // The HMAC key and anchors live outside the workspace, so workspace writes cannot forge or truncate state.
  const keyDir = resolve(config.keyDir || defaultKeyDir())
  // An unusable key directory (inside the workspace, wrong owner/permissions, creation
  // failure) must not crash the profile: every session denies all tools with a notice.
  let keyring: Keyring | undefined
  let keyFailure: string | undefined
  /** Pending while a key that another process is still writing becomes readable (no blocking wait). */
  let keyringReady: Promise<void> | undefined
  const keyProblem = (error: unknown): string => `dsh-viztools cannot use its key directory (${error instanceof Error ? error.message : String(error)})`
  try {
    assertKeyDirOutside(keyDir, workspace)
    keyring = loadKeyring(keyDir)
    for (const notice of keyring.notices ?? []) warn(ctx, notice)
  } catch (error) {
    if (error instanceof KeyNotReadyError) {
      keyringReady = loadKeyringAsync(keyDir).then((loaded) => { keyring = loaded }, (retryError: unknown) => { keyFailure = keyProblem(retryError); warn(ctx, keyFailure) })
    } else {
      keyFailure = keyProblem(error)
      warn(ctx, keyFailure)
    }
  }
  const forcedReaders = new Set(config.keyProtection.fileReadingTools)
  const safePatterns = [...BUILTIN_SAFE_TOOLS, ...config.keyProtection.safeTools]
  /** Deny by default: a tool is a reader unless it is vouched safe (and not forced a reader). */
  const isReader = (tool: string): boolean => forcedReaders.has(tool) || !safePatterns.some((pattern) => safePatternMatches(pattern, tool))
  const subprocessTools = new Set(SANDBOXED_SUBPROCESS_TOOLS)
  /** Probe verdicts per (mode, workspace root): whether tool subprocesses cannot read the key. */
  const probes = new Map<string, boolean | Promise<boolean>>()
  const planningTools = new Set(config.planFirst.planningTools)
  const controlTools = new Set<string>()
  if (config.planFirst.enabled) controlTools.add(EXIT_PLAN_MODE)
  if (config.runRules.enabled) controlTools.add(PROPOSE_RUN_RULES)
  const limitedTools = new Set(config.runRules.enabled ? Object.keys(config.runRules.maxLimits) : [])
  const gates = new WeakMap<Agent, AgentGate>()
  const gatesBySession = new Map<string, AgentGate>()
  /** Gates with a delegation call in flight, used to attach the child that call creates. */
  const delegating = new Map<string, AgentGate>()
  const deploymentAllowed = new Set(config.runRules.allowedTools)
  const fingerprint = deploymentFingerprint(config.runRules.allowedTools, config.runRules.maxLimits)

  function publishStatus(gate: AgentGate): void {
    if (!isSafeSessionId(gate.sessionId)) return
    const target = join(stateRoot, `${gate.sessionId}.status.json`)
    const status = {
      sessionId: gate.sessionId,
      backend: gate.store.backend,
      planApproved: gate.fold.approved,
      ...(gate.planNotice === undefined ? {} : { planNotice: gate.planNotice }),
      ...(gate.stateNotice === undefined ? {} : { stateNotice: gate.stateNotice }),
      ...(gate.countsUntrusted === undefined ? {} : { countsUntrusted: gate.countsUntrusted }),
      ...(gate.fold.malformed === undefined ? {} : { stateBroken: gate.fold.malformed }),
      ...(config.runRules.enabled && gate.fold.rulesInvalid !== undefined ? { rulesInvalid: gate.fold.rulesInvalid } : {}),
      updatedAt: Date.now(),
    }
    try {
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
      const temporary = `${target}.tmp-${process.pid}`
      writeFileSync(temporary, JSON.stringify(status, null, 2), { mode: 0o600 })
      renameSync(temporary, target)
    } catch (error) {
      warn(ctx, `could not publish gate status for ${gate.sessionId}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  interface SandboxLike { confine(argv: readonly string[], policy: unknown): Promise<{ argv: string[] }> }
  interface PolicyLike { resolve?(request: { session: unknown }): { mode?: string; workspaceRoot?: string }; defaultMode?: string }
  const service = <T>(agent: Agent, name: string, check: (value: unknown) => boolean): T | undefined => {
    for (const scope of [ctx, agent.ctx]) {
      try {
        const value = (scope as unknown as { get(name: string): unknown }).get(name)
        if (value !== undefined && value !== null && check(value)) return value as T
      } catch { /* not visible from this scope */ }
    }
    return undefined
  }

  /** File-reading tools this deployment lets the agent use (now or after approval). */
  let readerCache = new WeakMap<Agent, string[]>()
  ctx.on('tools/change', () => { readerCache = new WeakMap() })
  function exposedReaders(agent: Agent): string[] {
    const cached = readerCache.get(agent)
    if (cached !== undefined) return cached
    const candidates = new Set<string>()
    if (config.runRules.enabled) for (const tool of config.runRules.allowedTools) candidates.add(tool)
    else {
      for (const tool of planningTools) candidates.add(tool)
      try { for (const schema of agent.ctx.tools.schemas(agent)) candidates.add(schema.name) } catch { /* registry unavailable: planning tools only */ }
    }
    if (config.planFirst.allowPtcTransport) candidates.add(RUN_CODE)
    const readers = [...candidates].filter(isReader).sort()
    readerCache.set(agent, readers)
    return readers
  }

  function runConfined(sandbox: SandboxLike, policy: unknown, path: string): Promise<boolean> {
    return sandbox.confine(['cat', '--', path], policy).then((confined) => new Promise<boolean>((resolveRead) => {
      const [command, ...args] = confined.argv
      if (command === undefined) { resolveRead(false); return }
      const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'ignore'] })
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolveRead(false) }, 10_000)
      timer.unref()
      child.once('error', () => { clearTimeout(timer); resolveRead(false) })
      child.once('close', (code) => { clearTimeout(timer); resolveRead(code === 0) })
    }), () => false)
  }

  /**
   * Whether tool subprocesses CANNOT read the key under this session's policy. DSH's file
   * sandbox restricts writes only, so by default they can. The verdict is positive only when
   * a confined `cat` reads a control file in the workspace but fails on the key file.
   */
  function probeKey(agent: Agent): { key: string; verdict: boolean | Promise<boolean> } {
    const sandbox = service<SandboxLike>(agent, 'sandbox', (value) => typeof (value as SandboxLike).confine === 'function')
    const policyService = service<PolicyLike>(agent, 'sandboxPolicy', (value) => typeof value === 'object')
    if (keyring === undefined || sandbox === undefined) return { key: 'none', verdict: false }
    // Same resolution as run_code's policy check: DSH's resolve(), else the log override, else the default.
    const mode = sessionSandboxMode(agent, policyService)
    if (mode === undefined || mode === 'danger-full-access') return { key: mode ?? 'unknown', verdict: false }
    let workspaceRoot = workspace
    try { workspaceRoot = policyService?.resolve?.({ session: agent.session }).workspaceRoot ?? workspace } catch { /* fall back to the gate workspace */ }
    const policy = { mode, workspaceRoot, sessionId: String(agent.id) }
    const key = `${policy.mode}\u0000${policy.workspaceRoot}`
    const known = probes.get(key)
    if (known !== undefined) return { key, verdict: known }
    const control = join(stateRoot, '.key-probe-control')
    const pending = (async () => {
      try {
        mkdirSync(stateRoot, { recursive: true, mode: 0o700 })
        writeFileSync(control, 'control\n', { mode: 0o600 })
      } catch { return false }
      const controlReadable = await runConfined(sandbox, policy, control)
      const keyReadable = await runConfined(sandbox, policy, join(keyring.dir, 'sidecar.key'))
      return controlReadable && !keyReadable
    })()
    probes.set(key, pending)
    void pending.then((verdict) => probes.set(key, verdict))
    return { key, verdict: pending }
  }

  /** Deny-all reason when a file-reading tool is allowed and the key is not proven unreadable. */
  function keyExposure(agent: Agent): string | undefined {
    const readers = exposedReaders(agent)
    if (readers.length === 0) return undefined
    // A subprocess probe can only vouch for tools that run as sandboxed subprocesses.
    const unconfinable = readers.filter((tool) => !subprocessTools.has(tool))
    if (unconfinable.length > 0) {
      return `dsh-viztools gate state is tamper-evident only against agents that cannot read ${keyring?.dir ?? 'its key directory'}, but ${unconfinable.join(', ')} may read files from inside DSH or an MCP server, where no sandbox probe can vouch for them. Remove them, or list them in keyProtection.safeTools only if they cannot read files`
    }
    const { verdict } = probeKey(agent)
    if (verdict === true) return undefined
    return `dsh-viztools gate state is tamper-evident only against agents that cannot read ${keyring?.dir ?? 'its key directory'}, but ${readers.join(', ')} can read files and tool subprocesses can read the key (DSH's file sandbox restricts writes, not reads)${verdict === false ? '' : '; the key protection probe is still running'}. Remove those tools from this deployment or run them under a sandbox that denies reads of the key directory`
  }

  /** Durably record and apply one change; on failure retry once, then queue it. */
  function record(gate: AgentGate, kind: GateRecordKind, data: { [key: string]: JsonValue }): boolean {
    flushPending(gate)
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const written = gate.store.append(kind, data)
        gate.fold = applyGateRecord(gate.fold, written)
        return true
      } catch (error) {
        if (attempt === 1) warn(ctx, `could not persist gate record ${kind} for ${gate.sessionId}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    gate.pending.push({ kind, data })
    // Apply in memory anyway so live policy stays at least as strict as intended.
    gate.fold = applyGateRecord(gate.fold, { kind, data, t: Date.now() })
    return false
  }

  function flushPending(gate: AgentGate): void {
    while (gate.pending.length > 0) {
      const next = gate.pending[0] as { kind: GateRecordKind; data: { [key: string]: JsonValue } }
      try {
        gate.store.append(next.kind, next.data)
        gate.pending.shift()
      } catch {
        return
      }
    }
  }

  /** Replay durable state for one agent's own session and fail closed on any doubt. */
  function open(agent: Agent): AgentGate {
    const sessionId = String(agent.id)
    const store: StateStore = keyring === undefined
      ? { backend: 'sidecar', location: stateRoot, read: () => { throw new Error(keyFailure) }, append: () => { throw new Error(keyFailure) } }
      : openStateStore({ root: stateRoot, session: agent.session as never, channel: 'gate', keyring, ...(hooks.pluginRecords === undefined ? {} : { pluginRecords: hooks.pluginRecords }) })
    let snapshot: ReturnType<StateStore['read']>
    let fold: GateFold
    let trust: ReturnType<typeof evaluateTrust>
    try {
      snapshot = store.read()
      fold = foldGateRecords(snapshot.records)
      trust = evaluateTrust(agent.session.snapshotEvents(), snapshot, fold, limitedTools)
    } catch (error) {
      // Unreadable state must not break session creation: deny everything with a notice.
      const reason = keyFailure ?? `dsh-viztools gate state for this session could not be read (${error instanceof Error ? error.message : String(error)})`
      warn(ctx, reason)
      const broken: AgentGate = { store, sessionId, fold: { ...foldGateRecords([]), malformed: reason }, reserved: new Map(), audited: new Set(), verdicts: new Map(), pending: [] }
      gates.set(agent, broken)
      gatesBySession.set(sessionId, broken)
      return broken
    }
    if (fold.malformed !== undefined) warn(ctx, fold.malformed)
    const gate: AgentGate = { store, sessionId, fold, reserved: new Map(), audited: new Set(), verdicts: new Map(), pending: [] }
    if (!trust.countsTrusted) gate.countsUntrusted = trust.reason ?? 'dsh-viztools gate counts cannot be trusted'
    if (trust.needsReset || trust.missing) {
      // Void approval and rules now (a reset record is written first by the store when damaged).
      gate.stateNotice = `${trust.reason}. Plan approval was reset${config.runRules.enabled ? ' and saved run rules are refused' : ''}${limitedTools.size > 0 ? '; tools with call limits stay refused for this session' : ''}.`
      record(gate, 'reset', { reason: trust.reason ?? 'plugin state was damaged' })
      fold = gate.fold
    } else if (trust.reason !== undefined) {
      gate.stateNotice = `${trust.reason}; tools with call limits stay refused for this session.`
    }
    if (config.runRules.enabled && fold.rules !== undefined && fold.rulesInvalid === undefined && !rulesValidForDeployment(fold.rules, deploymentAllowed, config.runRules.maxLimits)) {
      // Never widen: rules that no longer fit the deployment become "deny every governed tool".
      record(gate, 'rules-invalidated', { reason: 'Saved run rules no longer fit this deployment (allowed tools or limits changed)', fingerprint: fold.rules.deploymentFingerprint })
    }
    gates.set(agent, gate)
    gatesBySession.set(sessionId, gate)
    return gate
  }

  function liveCounts(gate: AgentGate): Record<string, number> {
    const counts: Record<string, number> = { ...gate.fold.counts }
    for (const tool of gate.reserved.values()) counts[tool] = (counts[tool] ?? 0) + 1
    return counts
  }

  /** Persist a final guard refusal exactly once per call id. */
  function audit(gate: AgentGate, callId: string, tool: string, denial: GateDenial): void {
    if (gate.audited.has(callId)) return
    gate.audited.add(callId)
    record(gate, 'refused', {
      callId, tool, code: denial.code, reason: denial.reason, beforeApproval: config.planFirst.enabled && !gate.fold.approved,
      ...(denial.count === undefined ? {} : { count: denial.count }), ...(denial.limit === undefined ? {} : { limit: denial.limit }),
    })
  }

  /** Calls whose start is recorded: every governed (non-control) tool while the gate is active. */
  function counted(tool: string): boolean {
    return !controlTools.has(tool)
  }

  function ptcPolicy(agent: Agent): { allowed: boolean; reason?: string } {
    if (!config.planFirst.allowPtcTransport) return { allowed: false, reason: 'run_code is refused before plan approval: its program can use Node APIs (fs, net, child_process), so it would bypass the gate. A deployment can opt in with planFirst.allowPtcTransport when the file policy is confined.' }
    const mode = sessionSandboxMode(agent, ctx.get('sandboxPolicy' as never) ?? agent.ctx.get('sandboxPolicy' as never))
    if (mode === undefined || mode === 'danger-full-access') return { allowed: false, reason: `run_code is refused before plan approval because the session file policy is ${mode ?? 'unknown'}; it is allowed only under a confined (read-only or workspace-write) policy.` }
    return { allowed: true }
  }

  if (config.runRules.enabled) {
    ctx.tools.register(defineTool({
      name: PROPOSE_RUN_RULES,
      description: 'Propose narrowing run rules for user approval. Omit `allow` to keep the deployment allowed set; an empty `allow` list denies every governed tool. Rules can never enable tools outside the deployment allowed set or exceed deployment limits.',
      parameters: {
        allow: { type: 'array', items: { type: 'string' } },
        deny: { type: 'array', items: { type: 'string' }, required: true },
        limits: { type: 'object', additionalProperties: true, required: true },
        notes: { type: 'array', items: { type: 'string' }, required: true },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { approved: { type: 'boolean', const: true, required: true } } },
        render: () => [{ type: 'text', text: 'Run rules approved and enforced.' }],
      },
      async execute(args, exec) {
        const agent = exec.agent
        if (agent === undefined) throw new Error('propose_run_rules requires a calling agent')
        const limits: Record<string, number> = {}
        for (const [tool, value] of Object.entries(args.limits)) {
          if (typeof value !== 'number') throw new Error(`run rule limit for ${tool} must be numeric`)
          limits[tool] = value
        }
        const proposed: RunRules = { version: RUN_RULES_VERSION, ...(args.allow === undefined ? {} : { allow: args.allow }), deny: args.deny, limits, notes: args.notes, deploymentFingerprint: fingerprint }
        // The agent's own view: preset-scoped MCP tools are invisible in the global view.
        const rules = validateRules(proposed, config.runRules, agent.ctx.tools.schemas(agent).map((schema) => schema.name))
        const answer = await ctx.userQuestions.ask({
          questions: [{
            id: 'run-rules-review',
            header: 'Run rules review',
            question: 'Approve these narrowing run rules?',
            detail: JSON.stringify(rules, null, 2),
            options: [{ label: 'Approve' }, { label: 'Reject' }],
          }],
          agent,
          signal: exec.signal,
        })
        const item = answer.answers.find((entry) => entry.id === 'run-rules-review')
        if (item?.selected.length !== 1 || item.selected[0] !== 'Approve' || item.custom !== undefined) throw new Error('The user rejected the proposed run rules.')
        const gate = gates.get(agent) ?? open(agent)
        if (!record(gate, 'rules-approved', { callId: String(exec.callId), rules: rules as unknown as JsonValue })) throw new Error('The approved run rules could not be stored durably; they apply to this live session only.')
        publishStatus(gate)
        return { approved: true }
      },
    }))
  }

  ctx.on('agent/created', ({ agent }) => keyringReady === undefined ? onCreated(agent) : keyringReady.then(() => onCreated(agent)).then(() => undefined))

  function onCreated(agent: Agent): Promise<undefined> | undefined {
    const header = agent.session.header as { parentSession?: unknown; delegationDepth?: unknown }
    const depth = typeof header.delegationDepth === 'number' ? header.delegationDepth : 0
    const isChild = depth > 0
    let gate: AgentGate | undefined
    if (isChild && config.delegation.allow) {
      // A delegated child shares its parent's gate: same approval, rules, and counts.
      const byLineage = header.parentSession === undefined ? undefined : gatesBySession.get(String(header.parentSession))
      gate = byLineage ?? (delegating.size === 1 ? [...delegating.values()][0] : undefined)
    }
    if (gate === undefined) {
      gate = open(agent)
      if (isChild) {
        // A child we cannot attach to a governed parent must not get a fresh budget.
        gate.countsUntrusted ??= 'this delegated agent could not be attached to its parent\'s gate'
        if (config.runRules.enabled && gate.fold.rulesInvalid === undefined) gate.fold = { ...gate.fold, rulesInvalid: 'This delegated agent could not inherit its parent\'s run rules' }
      }
    } else {
      gates.set(agent, gate)
    }
    const current = gate
    agent.ctx.effect(() => agent.ctx.systemPrompt.section({
      name: 'viztools:run-rules-notes',
      order: 700,
      text: () => {
        const rules = gates.get(agent)?.fold.rules
        if (rules === undefined || rules.notes.length === 0) return ''
        return `Approved run-rule notes (advisory; not mechanically enforced):\n${rules.notes.map((note) => `- ${note}`).join('\n')}`
      },
    }), 'dsh-viztools.run-rules-notes')
    if (!current.fold.approved && config.planFirst.enabled && !isChild) {
      const planMode = resolvePlanMode(ctx, agent)
      if (planMode === undefined) {
        current.planNotice = 'Plan mode is unavailable in this deployment, so this session cannot submit a plan for approval (mount dsh-viztools/gate inside the preset `planning` group that isolates planMode). Ask the operator.'
        warn(ctx, `planFirst.enabled: ${current.planNotice}`)
      } else {
        planMode.set(agent, true)
      }
    }
    if (!isChild) publishStatus(current)

    // Tool visibility is deliberately NOT checked at creation: MCP tools register later.
    agent.ctx.effect(() => agent.ctx.tools.guard((exec) => {
      const caller = exec.agent
      const active = caller === undefined ? undefined : gates.get(caller)
      const callId = String(exec.callId)
      // Nested scopes can run more than one instance of this guard for the same call.
      if (active !== undefined && active.verdicts.has(callId)) return active.verdicts.get(callId)
      if (active !== undefined) flushPending(active)
      const planNotice = [active?.planNotice, active?.stateNotice].filter((text) => text !== undefined).join(' ')
      const ptc = exec.name === RUN_CODE && caller !== undefined ? ptcPolicy(caller) : { allowed: false }
      const denial = decideTool({
        knownAgent: active !== undefined,
        planFirst: config.planFirst.enabled,
        planApproved: active?.fold.approved ?? false,
        planningTools,
        controlTools,
        ptcBeforeApproval: ptc.allowed,
        ...(ptc.reason === undefined ? {} : { ptcDeniedReason: ptc.reason }),
        delegationAllowed: config.delegation.allow,
        deploymentRestricted: config.runRules.enabled,
        deploymentAllowed,
        deploymentLimits: config.runRules.maxLimits,
        ...(active?.fold.rules === undefined ? {} : { rules: active.fold.rules }),
        ...(config.runRules.enabled && active?.fold.rulesInvalid !== undefined ? { rulesInvalid: active.fold.rulesInvalid } : {}),
        ...(active?.countsUntrusted === undefined ? {} : { countsUntrusted: active.countsUntrusted }),
        ...(() => {
          if (active === undefined || caller === undefined) return {}
          const broken = active.fold.malformed ?? keyExposure(caller)
          return broken === undefined ? {} : { stateBroken: broken }
        })(),
        counts: active === undefined ? {} : liveCounts(active),
        tool: exec.name,
        denialMessage: config.planFirst.denialMessage,
        ...(planNotice === '' ? {} : { planNotice }),
      })
      if (active === undefined) return denial?.reason
      if (denial !== undefined) {
        // Guards are monotonic and evaluated once per call, so our denial is final: persist it now.
        audit(active, callId, exec.name, denial)
        active.verdicts.set(callId, denial.reason)
        return denial.reason
      }
      // A tool that does not exist will never run: it must not use up a limit slot.
      const visible = caller === undefined || caller.ctx.tools.get(exec.name, caller) !== undefined
      if (counted(exec.name) && visible) active.reserved.set(callId, exec.name)
      if (DELEGATION_TOOLS.has(exec.name)) delegating.set(callId, active)
      active.verdicts.set(callId, undefined)
      return undefined
    }), 'dsh-viztools.monotonic-gate')

    // Dispatch began: the call passed every guard. Record the start durably before the body
    // runs, so failures still consume the slot and replay matches live state exactly.
    agent.ctx.on('tools/execute', async (exec, next) => {
      const caller = exec.agent ?? agent
      const active = gates.get(caller)
      const callId = String(exec.callId)
      let recorded = false
      if (active !== undefined && counted(exec.name) && !active.fold.decided.has(callId) && !exec.signal.aborted && caller.ctx.tools.get(exec.name, caller) !== undefined) {
        active.reserved.delete(callId)
        record(active, 'started', { callId, tool: exec.name })
        recorded = true
      }
      const result = await next()
      const code = errorCode(result)
      if (recorded && active !== undefined && (code === 'ABORTED_BEFORE_DISPATCH' || code === 'UNKNOWN_TOOL')) {
        // The body never ran: give the slot back durably.
        record(active, 'not-started', { callId, tool: exec.name, reason: code })
      }
      return result
    })
    // The guard is synchronous: settle the key-protection probe in the async pre-execute stage
    // (which DSH runs before guards), so a mid-session mode change is probed before deciding.
    agent.ctx.on('tools/pre-execute', async (_exec, next) => {
      if (exposedReaders(agent).length > 0) await probeKey(agent).verdict
      return next()
    })
    if (exposedReaders(agent).length > 0) return Promise.resolve(probeKey(agent).verdict).then(() => undefined)
    return undefined
  }

  ctx.on('tools/result', (exec, result) => {
    const agent = exec.agent
    if (agent === undefined) return
    const gate = gates.get(agent)
    if (gate === undefined) return
    const callId = String(exec.callId)
    delegating.delete(callId)
    gate.verdicts.delete(callId)
    flushPending(gate)
    // A reservation that never dispatched (another guard denied, cancelled before dispatch,
    // unknown tool) is released, with a durable decision for limited tools.
    gate.reserved.delete(callId)
    if (counted(exec.name) && limitedTools.has(exec.name) && !gate.fold.decided.has(callId)) {
      record(gate, 'not-started', { callId, tool: exec.name, reason: errorCode(result) ?? 'not dispatched' })
    }
    if (exec.name !== EXIT_PLAN_MODE || result.isError || !config.planFirst.enabled) return
    const value = result.value
    if (typeof value !== 'object' || value === null || Array.isArray(value) || (value as Record<string, unknown>).approved !== true) return
    if (gate.fold.approved) return
    record(gate, 'plan-approved', { planCallId: callId })
    delete gate.stateNotice
    publishStatus(gate)
  })
}

apply.Config = Config
