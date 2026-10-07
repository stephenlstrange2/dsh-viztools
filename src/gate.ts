import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEventMap } from '@deepseek-ai/dsh-session'
import { EXIT_PLAN_MODE } from '@deepseek-ai/dsh-plan-mode'
import z from '@deepseek-ai/schemastery'
import { foldGate, GATE_EVENT_TYPE, type GateChange, type GateState } from './gate-domain.js'

export { GATE_EVENT_TYPE, decodeGateChange, foldGate, initialGateState } from './gate-domain.js'
export type { GateChange, GateState } from './gate-domain.js'

export const name = 'dsh-viztools-gate'
export const inject = ['tools', 'planMode']

export interface PlanFirstConfig {
  enabled?: boolean
  planningTools?: string[]
  denialMessage?: string
}

export interface Config {
  planFirst?: PlanFirstConfig
}

export interface ResolvedConfig {
  planFirst: {
    enabled: boolean
    planningTools: string[]
    denialMessage: string
  }
}

export const Config = z.object({
  planFirst: z.object({
    enabled: z.boolean().default(false),
    planningTools: z.array(String).default([]),
    denialMessage: z.string().default('Plan not approved yet.'),
  }).default({}),
})

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Durable plan-gate approval or refusal audit event. */
    'viztools-gate/change': GateChange
  }
}

interface AgentGate {
  state: GateState
  readonly refusedCallIds: Set<string>
}

export function resolveGateConfig(config: ResolvedConfig): ResolvedConfig {
  const tools = [...new Set(config.planFirst.planningTools.map((tool) => tool.trim()))]
  if (tools.some((tool) => tool.length === 0)) throw new Error('planFirst.planningTools entries must be non-empty')
  const denialMessage = config.planFirst.denialMessage.trim()
  if (denialMessage.length === 0) throw new Error('planFirst.denialMessage must be non-empty')
  return { planFirst: { ...config.planFirst, planningTools: tools, denialMessage } }
}

function append(agent: Agent, change: GateChange): void {
  agent.session.append(GATE_EVENT_TYPE, change as SessionEventMap[typeof GATE_EVENT_TYPE])
}

/** Install the durable plan-first enforcement gate. */
export function apply(ctx: Context, input: ResolvedConfig): void {
  const config = resolveGateConfig(input)
  if (!config.planFirst.enabled) return

  const planning = new Set([...config.planFirst.planningTools, EXIT_PLAN_MODE])
  const gates = new WeakMap<Agent, AgentGate>()

  ctx.on('agent/created', ({ agent }) => {
    const state = foldGate(agent.session.snapshotEvents())
    gates.set(agent, { state, refusedCallIds: new Set() })
    if (!state.approved) ctx.planMode.set(agent, true)
    const visible = new Set(agent.ctx.tools.schemas().map((schema) => schema.name))
    const missing = [...planning].filter((tool) => !visible.has(tool))
    if (missing.length > 0) throw new Error(`planFirst.planningTools are not visible to agent ${String(agent.id)}: ${missing.join(', ')}`)
    agent.ctx.on('tools/pre-execute', async (exec, next) => {
      const gate = gates.get(agent)
      if (gate === undefined || gate.state.approved || planning.has(exec.name)) return next()
      if (!gate.refusedCallIds.has(String(exec.callId))) {
        gate.refusedCallIds.add(String(exec.callId))
        append(agent, {
          kind: 'refused',
          version: 1,
          callId: String(exec.callId),
          tool: exec.name,
          reason: config.planFirst.denialMessage,
        })
        gate.state = { ...gate.state, refusals: gate.state.refusals + 1 }
      }
      return {
        kind: 'deny',
        reason: config.planFirst.denialMessage,
        info: { name: 'PlanGateError', code: 'PLAN_NOT_APPROVED' },
      }
    })
    return undefined
  })

  ctx.on('tools/result', (exec, result) => {
    const agent = exec.agent
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
