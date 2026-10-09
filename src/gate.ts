import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEventMap } from '@deepseek-ai/dsh-session'
import { EXIT_PLAN_MODE } from '@deepseek-ai/dsh-plan-mode'
import type {} from '@deepseek-ai/dsh-user-questions'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { foldGate, GATE_EVENT_TYPE, type GateChange, type GateState } from './gate-domain.js'
import { decideTool, expandPatterns } from './gate-policy.js'
import { deploymentFingerprint, foldRunRules, mergeRules, rulesValidForDeployment, RUN_RULES_EVENT, RUN_RULES_VERSION, type RunRules, type RunRulesChange, type RunRulesState } from './run-rules.js'

export { GATE_EVENT_TYPE, decodeGateChange, foldGate, initialGateState } from './gate-domain.js'
export type { GateChange, GateState } from './gate-domain.js'

export const name = 'dsh-viztools-gate'
export const inject = ['tools', 'userQuestions', 'systemPrompt']

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
    /** Durable approved run rules and their refusal audit events. */
    'viztools-run-rules/change': RunRulesChange
  }
}

interface AgentGate {
  state: GateState
  rules: RunRulesState
  readonly refusedCallIds: Set<string>
  readonly pendingDenials: Map<string, { code: string; reason: string; count?: number; limit?: number }>
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
  return {
    planFirst: { ...config.planFirst, planningTools: tools, denialMessage },
    runRules: { ...config.runRules, allowedTools, maxLimits: { ...config.runRules.maxLimits } },
  }
}

function append(agent: Agent, change: GateChange): void {
  agent.session.append(GATE_EVENT_TYPE, change as SessionEventMap[typeof GATE_EVENT_TYPE])
}

function appendRules(agent: Agent, change: RunRulesChange): void {
  agent.session.append(RUN_RULES_EVENT, change as SessionEventMap[typeof RUN_RULES_EVENT])
}

function validateRules(rules: RunRules, config: ResolvedConfig['runRules'], registryTools: string[]): RunRules {
  const grammar = /^[A-Za-z0-9_-]+(?:__[A-Za-z0-9_-]+)*(?:\*)?$/
  for (const pattern of [...rules.allow, ...rules.deny]) {
    if (!grammar.test(pattern) || (pattern.includes('*') && !pattern.endsWith('*'))) throw new Error(`invalid tool pattern ${pattern}`)
    const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern
    if (!config.allowedTools.some((tool) => tool === prefix || tool.startsWith(prefix))) throw new Error(`rule names tool outside deployment allowed set: ${pattern}`)
  }
  const deploymentAllowed = new Set(config.allowedTools)
  const allow = expandPatterns(rules.allow, registryTools, deploymentAllowed)
  const deny = expandPatterns(rules.deny, registryTools, deploymentAllowed)
  for (const [tool, limit] of Object.entries(rules.limits)) {
    const cap = config.maxLimits[tool]
    if (cap === undefined) throw new Error(`rule limit names unsupported tool: ${tool}`)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > cap) throw new Error(`rule limit for ${tool} must be between 1 and ${cap}`)
  }
  return { ...rules, allow, deny, deploymentFingerprint: deploymentFingerprint(config.allowedTools, config.maxLimits) }
}

/** Install the durable plan-first enforcement gate. */
export function apply(ctx: Context, input: ResolvedConfig): void {
  const config = resolveGateConfig(input)
  if (!config.planFirst.enabled && !config.runRules.enabled) return

  const planning = new Set([...config.planFirst.planningTools, EXIT_PLAN_MODE])
  const gates = new WeakMap<Agent, AgentGate>()
  const deploymentAllowed = new Set(config.runRules.allowedTools)

  if (config.runRules.enabled) {
    ctx.tools.register(defineTool({
      name: 'propose_run_rules',
      description: 'Propose narrowing run rules for user approval. Rules can never enable tools outside the deployment allowed set or exceed deployment limits.',
      parameters: {
        allow: { type: 'array', items: { type: 'string' }, required: true },
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
        const proposed: RunRules = { version: RUN_RULES_VERSION, allow: args.allow, deny: args.deny, limits, notes: args.notes, deploymentFingerprint: deploymentFingerprint(config.runRules.allowedTools, config.runRules.maxLimits) }
        const rules = validateRules(proposed, config.runRules, agent.ctx.tools.schemas().map((schema) => schema.name))
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
        appendRules(agent, { kind: 'approved', version: RUN_RULES_VERSION, callId: String(exec.callId), rules })
        const gate = gates.get(agent)
        if (gate !== undefined) gate.rules = { ...gate.rules, rules: mergeRules(gate.rules.rules, rules), approvedAtSeq: Number(agent.session.seq) - 1 }
        return { approved: true }
      },
    }))
  }

  ctx.on('agent/created', ({ agent }) => {
    const events = agent.session.snapshotEvents()
    const state = foldGate(events)
    let rules = foldRunRules(events)
    if (rules.rules !== undefined && !rulesValidForDeployment(rules.rules, deploymentAllowed, config.runRules.maxLimits)) {
      const { rules: _invalidRules, approvedAtSeq: _approvedAtSeq, ...safeState } = rules
      rules = safeState
    }
    gates.set(agent, { state, rules, refusedCallIds: new Set(), pendingDenials: new Map() })
    agent.ctx.effect(() => agent.ctx.systemPrompt.section({
      name: 'viztools:run-rules-notes',
      order: 700,
      text: () => {
        const current = gates.get(agent)?.rules.rules
        if (current === undefined || current.notes.length === 0) return ''
        return `Approved run-rule notes (advisory; not mechanically enforced):\n${current.notes.map((note) => `- ${note}`).join('\n')}`
      },
    }), 'dsh-viztools.run-rules-notes')
    if (!state.approved && config.planFirst.enabled) {
      const planMode = ctx.get('planMode')
      if (planMode === undefined) throw new Error('planFirst.enabled requires the planMode service')
      planMode.set(agent, true)
    }
    const visible = new Set(agent.ctx.tools.schemas().map((schema) => schema.name))
    const missing = [...planning, ...(config.runRules.enabled ? config.runRules.allowedTools : [])].filter((tool) => !visible.has(tool))
    if (missing.length > 0) throw new Error(`planFirst.planningTools are not visible to agent ${String(agent.id)}: ${missing.join(', ')}`)
    agent.ctx.effect(() => agent.ctx.tools.guard((exec) => {
      const current = exec.agent === undefined ? undefined : gates.get(exec.agent)
      const governedDelegation = current?.rules.rules !== undefined && (exec.name === 'subagent' || exec.name === 'subagent_fork' || exec.name === 'workflow')
      if (governedDelegation) {
        const reason = 'Forks, subagents, and workflows are disabled while approved OTX run rules govern this session.'
        current?.pendingDenials.set(String(exec.callId), { code: 'RUN_RULE_DENIED', reason })
        return reason
      }
      const denial = decideTool({
        knownAgent: current !== undefined,
        planApproved: current?.state.approved ?? false,
        planningTools: planning,
        deploymentAllowed,
        deploymentLimits: config.runRules.maxLimits,
        ...(current?.rules.rules === undefined ? {} : { rules: current.rules.rules }),
        counts: current?.rules.counts ?? {},
        tool: exec.name,
      })
      if (denial !== undefined && current !== undefined) current.pendingDenials.set(String(exec.callId), denial)
      return denial?.reason
    }), 'dsh-viztools.monotonic-gate')
    agent.ctx.on('tools/pre-execute', async (exec, next) => {
      const gate = gates.get(agent)
      if (gate === undefined) return next()
      const denial = gate.pendingDenials.get(String(exec.callId))
      if (denial !== undefined && !gate.refusedCallIds.has(String(exec.callId))) {
        gate.refusedCallIds.add(String(exec.callId))
        if (denial.code === 'PLAN_NOT_APPROVED' || denial.code === 'GATE_STATE_UNAVAILABLE' || denial.code === 'DEPLOYMENT_TOOL_DENIED') {
          append(agent, { kind: 'refused', version: 1, callId: String(exec.callId), tool: exec.name, reason: denial.reason })
          gate.state = { ...gate.state, refusals: gate.state.refusals + 1 }
        } else {
          const kind = denial.code === 'RUN_RULE_LIMIT' ? 'limit-reached' : 'refused-call'
          appendRules(agent, { kind, version: RUN_RULES_VERSION, callId: String(exec.callId), tool: exec.name, reason: denial.reason, ...(denial.count === undefined ? {} : { count: denial.count }), ...(denial.limit === undefined ? {} : { limit: denial.limit }) })
        }
      }
      return next()
    })
    return undefined
  })

  ctx.on('tools/result', (exec, result) => {
    const agent = exec.agent
    if (agent !== undefined && !result.isError) {
      const gate = gates.get(agent)
      if (gate?.rules.rules !== undefined && !gate.rules.acceptedCallIds.has(String(exec.callId))) {
        appendRules(agent, { kind: 'accepted-call', version: RUN_RULES_VERSION, callId: String(exec.callId), tool: exec.name })
        gate.rules = foldRunRules(agent.session.snapshotEvents())
      }
    }
    if (agent === undefined || exec.name !== EXIT_PLAN_MODE || result.isError) return
    const value = result.value
    if (typeof value !== 'object' || value === null || Array.isArray(value) || (value as Record<string, unknown>).approved !== true) return
    const gate = gates.get(agent)
    if (gate === undefined || gate.state.approved) return
    append(agent, { kind: 'approved', version: 1, planCallId: String(exec.callId) })
    gate.state = { ...gate.state, approved: true, approvedAtSeq: Number(agent.session.seq) - 1, planCallId: String(exec.callId) }
  })
}

apply.Config = Config
