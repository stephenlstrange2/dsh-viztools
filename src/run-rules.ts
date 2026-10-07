import type { SessionEvent } from '@deepseek-ai/dsh-session'

export const RUN_RULES_EVENT = 'viztools-run-rules/change' as const
export const RUN_RULES_VERSION = 1

export interface RunRules {
  readonly version: 1
  readonly allow: readonly string[]
  readonly deny: readonly string[]
  readonly limits: Readonly<Record<string, number>>
  readonly notes: readonly string[]
}

export type RunRulesChange = {
  readonly kind: 'approved'
  readonly version: 1
  readonly callId: string
  readonly rules: RunRules
} | {
  readonly kind: 'refused-call' | 'limit-reached'
  readonly version: 1
  readonly callId: string
  readonly tool: string
  readonly reason: string
  readonly count?: number
  readonly limit?: number
}

export interface RunRulesState {
  readonly rules?: RunRules
  readonly approvedAtSeq?: number
  readonly counts: Readonly<Record<string, number>>
  readonly refusals: readonly Extract<RunRulesChange, { kind: 'refused-call' | 'limit-reached' }>[]
}

export function initialRunRulesState(): RunRulesState {
  return { counts: {}, refusals: [] }
}

export function matchesTool(pattern: string, tool: string): boolean {
  if (pattern.endsWith('*')) return tool.startsWith(pattern.slice(0, -1))
  return pattern === tool
}

export function foldRunRules(events: readonly SessionEvent[]): RunRulesState {
  let state = initialRunRulesState()
  for (const event of events) {
    if (event.type === RUN_RULES_EVENT) {
      const change = event.data as unknown as RunRulesChange
      if (change.kind === 'approved') state = { ...state, rules: change.rules, approvedAtSeq: Number(event.seq) }
      else state = { ...state, refusals: [...state.refusals, change] }
    } else if (event.type === 'tool/call' || event.type === 'tool/ptc-dispatch-start') {
      const data = event.data as unknown as Record<string, unknown>
      if (typeof data.name !== 'string') continue
      state = { ...state, counts: { ...state.counts, [data.name]: (state.counts[data.name] ?? 0) + 1 } }
    }
  }
  return state
}

export function toolAllowed(rules: RunRules, tool: string): boolean {
  if (rules.deny.some((pattern) => matchesTool(pattern, tool))) return false
  return rules.allow.length === 0 || rules.allow.some((pattern) => matchesTool(pattern, tool))
}
