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
import { assertKeyDirOutside, defaultKeyDir, loadKeyring, openStateStore, type JsonValue, type Keyring, type PluginRecordApi, type StateStore } from './state-store.js'

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

export interface Config {
  planFirst?: PlanFirstConfig
  runRules?: RunRulesConfig
  delegation?: DelegationConfig
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
  return {
    ...config,
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
  const config = resolveGateConfig(input)
  if (!config.planFirst.enabled && !config.runRules.enabled) return

  const workspace = resolve(config.cwd || process.cwd())
  const stateRoot = resolve(workspace, config.stateDir)
  // The HMAC key and anchors live outside the workspace, so workspace writes cannot forge or truncate state.
  const keyDir = resolve(config.keyDir || defaultKeyDir())
  assertKeyDirOutside(keyDir, workspace)
  const keyring: Keyring = loadKeyring(keyDir)
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
    const store = openStateStore({ root: stateRoot, session: agent.session as never, channel: 'gate', keyring, ...(hooks.pluginRecords === undefined ? {} : { pluginRecords: hooks.pluginRecords }) })
    let snapshot: ReturnType<StateStore['read']>
    let fold: GateFold
    let trust: ReturnType<typeof evaluateTrust>
    try {
      snapshot = store.read()
      fold = foldGateRecords(snapshot.records)
      trust = evaluateTrust(agent.session.snapshotEvents(), snapshot, fold, limitedTools)
    } catch (error) {
      // Unreadable state must not break session creation: deny everything with a notice.
      const reason = `dsh-viztools gate state for this session could not be read (${error instanceof Error ? error.message : String(error)})`
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

  ctx.on('agent/created', ({ agent }) => {
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
        ...(active?.fold.malformed === undefined ? {} : { stateBroken: active.fold.malformed }),
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
    return undefined
  })

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
