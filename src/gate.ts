import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEventMap } from '@deepseek-ai/dsh-session'
import { EXIT_PLAN_MODE } from '@deepseek-ai/dsh-plan-mode'
import type {} from '@deepseek-ai/dsh-user-questions'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { foldGate, GATE_EVENT_TYPE, type GateChange, type GateState } from './gate-domain.js'
import { decideTool, expandPatterns, type GateDenial } from './gate-policy.js'
import { applyRunRulesChange, deploymentFingerprint, foldRunRules, initialRunRulesState, rulesValidForDeployment, RUN_RULES_EVENT, RUN_RULES_VERSION, type RunRules, type RunRulesChange, type RunRulesState } from './run-rules.js'

export { GATE_EVENT_TYPE, decodeGateChange, foldGate, initialGateState } from './gate-domain.js'
export type { GateChange, GateState } from './gate-domain.js'

export const name = 'dsh-viztools-gate'
export const inject = ['tools', 'userQuestions', 'systemPrompt']

export const PROPOSE_RUN_RULES = 'propose_run_rules'
export const RUN_CODE = 'run_code'
export const DELEGATION_TOOLS: ReadonlySet<string> = new Set(['subagent', 'subagent_fork', 'workflow'])

export interface PlanFirstConfig {
  enabled?: boolean
  planningTools?: string[]
  denialMessage?: string
}

export interface RunRulesConfig {
  enabled?: boolean
  allowedTools?: string[]
  maxLimits?: Record<string, number>
}

export interface Config {
  planFirst?: PlanFirstConfig
  runRules?: RunRulesConfig
}

export interface ResolvedConfig {
  planFirst: {
    enabled: boolean
    planningTools: string[]
    denialMessage: string
  }
  runRules: {
    enabled: boolean
    allowedTools: string[]
    maxLimits: Record<string, number>
  }
}

export const Config: z<Config, ResolvedConfig> = z.object({
  planFirst: z.object({
    enabled: z.boolean().default(false),
    planningTools: z.array(String).default([]),
    denialMessage: z.string().default('Plan not approved yet.'),
  }).default({}),
  runRules: z.object({
    enabled: z.boolean().default(false),
    allowedTools: z.array(String).default([]),
    maxLimits: z.dict(Number).default({}),
  }).default({}),
})

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Durable plan-gate approval or refusal audit event. */
    'viztools-gate/change': GateChange
    /** Durable approved run rules, started-call counts, and their refusal audit events. */
    'viztools-run-rules/change': RunRulesChange
  }
}

interface AgentGate {
  state: GateState
  rules: RunRulesState
  /** Calls that passed this guard but have not yet reached dispatch; they count against limits. */
  readonly reserved: Map<string, string>
  /** Call ids whose refusal was already persisted. */
  readonly audited: Set<string>
}

interface PlanModeLike {
  set(agent: Agent, active: boolean): unknown
}

export function resolveGateConfig(config: ResolvedConfig): ResolvedConfig {
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
    planFirst: { ...config.planFirst, planningTools: tools, denialMessage },
    runRules: { ...config.runRules, allowedTools, maxLimits: { ...config.runRules.maxLimits } },
  }
}

function append(agent: Agent, change: GateChange): void {
  agent.session.append(GATE_EVENT_TYPE, change as SessionEventMap[typeof GATE_EVENT_TYPE])
}

function appendRules(agent: Agent, change: RunRulesChange): number {
  agent.session.append(RUN_RULES_EVENT, change as SessionEventMap[typeof RUN_RULES_EVENT])
  return Number(agent.session.seq) - 1
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

/** Install the durable plan-first and run-rules enforcement gate. */
export function apply(ctx: Context, input: ResolvedConfig): void {
  const config = resolveGateConfig(input)
  if (!config.planFirst.enabled && !config.runRules.enabled) return

  const planningTools = new Set(config.planFirst.planningTools)
  const controlTools = new Set<string>([RUN_CODE])
  if (config.planFirst.enabled) controlTools.add(EXIT_PLAN_MODE)
  if (config.runRules.enabled) controlTools.add(PROPOSE_RUN_RULES)
  const gates = new WeakMap<Agent, AgentGate>()
  const deploymentAllowed = new Set(config.runRules.allowedTools)
  const fingerprint = deploymentFingerprint(config.runRules.allowedTools, config.runRules.maxLimits)

  /** Replay durable state; invalid or foreign-deployment rules are dropped (never widened). */
  function replay(agent: Agent): AgentGate {
    const events = agent.session.snapshotEvents()
    const state = foldGate(events)
    let rules = config.runRules.enabled ? foldRunRules(events) : initialRunRulesState()
    if (rules.rules !== undefined && !rulesValidForDeployment(rules.rules, deploymentAllowed, config.runRules.maxLimits)) {
      const { rules: _invalidRules, approvedAtSeq: _approvedAtSeq, ...safeState } = rules
      rules = safeState
    }
    const gate: AgentGate = { state, rules, reserved: new Map(), audited: new Set() }
    gates.set(agent, gate)
    return gate
  }

  function liveCounts(gate: AgentGate): Record<string, number> {
    const counts: Record<string, number> = { ...gate.rules.counts }
    for (const tool of gate.reserved.values()) counts[tool] = (counts[tool] ?? 0) + 1
    return counts
  }

  function applyRules(agent: Agent, gate: AgentGate, change: RunRulesChange): void {
    const seq = appendRules(agent, change)
    gate.rules = applyRunRulesChange(gate.rules, change, seq)
  }

  /** Persist a final guard refusal exactly once per call id. */
  function audit(agent: Agent, gate: AgentGate, callId: string, tool: string, denial: GateDenial): void {
    if (gate.audited.has(callId)) return
    gate.audited.add(callId)
    if (denial.code === 'RUN_RULE_DENIED' || denial.code === 'RUN_RULE_LIMIT') {
      applyRules(agent, gate, {
        kind: denial.code === 'RUN_RULE_LIMIT' ? 'limit-reached' : 'refused-call', version: RUN_RULES_VERSION, callId, tool, reason: denial.reason,
        ...(denial.count === undefined ? {} : { count: denial.count }), ...(denial.limit === undefined ? {} : { limit: denial.limit }),
      })
    } else {
      append(agent, { kind: 'refused', version: 1, callId, tool, reason: denial.reason })
      gate.state = { ...gate.state, refusals: gate.state.refusals + 1 }
    }
  }

  /** Whether this call is governed by counting (consumes a limit slot when started). */
  function counted(tool: string): boolean {
    return config.runRules.enabled && !controlTools.has(tool)
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
        const gate = gates.get(agent) ?? replay(agent)
        applyRules(agent, gate, { kind: 'approved', version: RUN_RULES_VERSION, callId: String(exec.callId), rules })
        return { approved: true }
      },
    }))
  }

  ctx.on('agent/created', ({ agent }) => {
    const gate = replay(agent)
    agent.ctx.effect(() => agent.ctx.systemPrompt.section({
      name: 'viztools:run-rules-notes',
      order: 700,
      text: () => {
        const current = gates.get(agent)?.rules.rules
        if (current === undefined || current.notes.length === 0) return ''
        return `Approved run-rule notes (advisory; not mechanically enforced):\n${current.notes.map((note) => `- ${note}`).join('\n')}`
      },
    }), 'dsh-viztools.run-rules-notes')
    if (!gate.state.approved && config.planFirst.enabled) {
      const planMode = resolvePlanMode(ctx, agent)
      // Fail closed without breaking session creation: the guard below still refuses
      // non-planning tools; only the automatic switch into plan mode is lost.
      if (planMode === undefined) warn(ctx, 'planFirst.enabled: planMode service is not visible; mount dsh-viztools/gate inside the preset `planning` cordis:group that isolates planMode. Non-planning tools stay refused.')
      else planMode.set(agent, true)
    }
    // Tool visibility is deliberately NOT checked here: MCP tools register after agent
    // creation, and `run_code` exists only in PTC presentation. Policy is decided per call.
    agent.ctx.effect(() => agent.ctx.tools.guard((exec) => {
      const caller = exec.agent
      const current = caller === undefined ? undefined : gates.get(caller) ?? replay(caller)
      const callId = String(exec.callId)
      let denial: GateDenial | undefined
      if (current !== undefined && current.rules.rules !== undefined && DELEGATION_TOOLS.has(exec.name)) {
        denial = { code: 'RUN_RULE_DENIED', reason: 'Forks, subagents, and workflows are disabled while approved OTX run rules govern this session.' }
      } else {
        denial = decideTool({
          knownAgent: current !== undefined,
          planFirst: config.planFirst.enabled,
          planApproved: current?.state.approved ?? false,
          planningTools,
          controlTools,
          deploymentRestricted: config.runRules.enabled,
          deploymentAllowed,
          deploymentLimits: config.runRules.maxLimits,
          ...(current?.rules.rules === undefined ? {} : { rules: current.rules.rules }),
          counts: current === undefined ? {} : liveCounts(current),
          tool: exec.name,
          denialMessage: config.planFirst.denialMessage,
        })
      }
      if (current === undefined || caller === undefined) return denial?.reason
      if (denial !== undefined) {
        // Guards are monotonic and evaluated once per call, so our denial is final: persist it now.
        audit(caller, current, callId, exec.name, denial)
        return denial.reason
      }
      // Reserve synchronously so parallel calls observe each other before any of them dispatches.
      if (counted(exec.name)) current.reserved.set(callId, exec.name)
      return undefined
    }), 'dsh-viztools.monotonic-gate')

    // Dispatch began: the call passed every guard. Count it durably before the body runs,
    // so failures still consume the slot and replay matches live state exactly.
    agent.ctx.on('tools/execute', async (exec, next) => {
      const current = gates.get(agent)
      const callId = String(exec.callId)
      if (current !== undefined && counted(exec.name) && !current.rules.startedCallIds.has(callId)) {
        current.reserved.delete(callId)
        applyRules(agent, current, { kind: 'started-call', version: RUN_RULES_VERSION, callId, tool: exec.name })
      }
      return next()
    })
    return undefined
  })

  ctx.on('tools/result', (exec, result) => {
    const agent = exec.agent
    if (agent === undefined) return
    const gate = gates.get(agent)
    if (gate === undefined) return
    // A reservation that never dispatched (another guard denied, or cancelled before dispatch) is released.
    gate.reserved.delete(String(exec.callId))
    if (exec.name !== EXIT_PLAN_MODE || result.isError || !config.planFirst.enabled) return
    const value = result.value
    if (typeof value !== 'object' || value === null || Array.isArray(value) || (value as Record<string, unknown>).approved !== true) return
    if (gate.state.approved) return
    append(agent, { kind: 'approved', version: 1, planCallId: String(exec.callId) })
    gate.state = { ...gate.state, approved: true, approvedAtSeq: Number(agent.session.seq) - 1, planCallId: String(exec.callId) }
  })
}

apply.Config = Config
