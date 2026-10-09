import { createHash } from 'node:crypto'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

export const RUN_RULES_EVENT = 'viztools-run-rules/change' as const
export const RUN_RULES_VERSION = 2

export interface RunRules {
  readonly version: 2
  readonly allow: readonly string[]
  readonly deny: readonly string[]
  readonly limits: Readonly<Record<string, number>>
  readonly notes: readonly string[]
  readonly deploymentFingerprint: string
}

export type RunRulesChange = {
  readonly kind: 'approved'
  readonly version: 2
  readonly callId: string
  readonly rules: RunRules
} | {
  readonly kind: 'accepted-call'
  readonly version: 2
  readonly callId: string
  readonly tool: string
} | {
  readonly kind: 'refused-call' | 'limit-reached'
  readonly version: 2
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
  readonly acceptedCallIds: ReadonlySet<string>
  readonly refusals: readonly Extract<RunRulesChange, { kind: 'refused-call' | 'limit-reached' }>[]
}

export function initialRunRulesState(): RunRulesState {
  return { counts: {}, acceptedCallIds: new Set(), refusals: [] }
}

export function deploymentFingerprint(allowedTools: readonly string[], maxLimits: Readonly<Record<string, number>>): string {
  return createHash('sha256').update(JSON.stringify({ allowedTools: [...allowedTools].sort(), maxLimits: Object.fromEntries(Object.entries(maxLimits).sort()) })).digest('hex')
}

export function mergeRules(previous: RunRules | undefined, proposed: RunRules): RunRules {
  if (previous === undefined) return proposed
  const priorAllow = new Set(previous.allow)
  const allow = previous.allow.length === 0 ? [...proposed.allow] : proposed.allow.length === 0 ? [...previous.allow] : proposed.allow.filter((tool) => priorAllow.has(tool))
  const deny = [...new Set([...previous.deny, ...proposed.deny])].sort()
  const limits: Record<string, number> = { ...previous.limits }
  for (const [tool, limit] of Object.entries(proposed.limits)) limits[tool] = limits[tool] === undefined ? limit : Math.min(limits[tool], limit)
  return { ...proposed, allow: [...new Set(allow)].sort(), deny, limits, notes: [...new Set([...previous.notes, ...proposed.notes])] }
}

export function rulesValidForDeployment(rules: RunRules, allowedTools: ReadonlySet<string>, maxLimits: Readonly<Record<string, number>>): boolean {
  if (rules.allow.some((tool) => !allowedTools.has(tool)) || rules.deny.some((tool) => !allowedTools.has(tool))) return false
  return Object.entries(rules.limits).every(([tool, limit]) => allowedTools.has(tool) && maxLimits[tool] !== undefined && limit <= maxLimits[tool])
}

export function foldRunRules(events: readonly SessionEvent[]): RunRulesState {
  let state = initialRunRulesState()
  for (const event of events) {
    if (event.type !== RUN_RULES_EVENT) continue
    const change = event.data as unknown as RunRulesChange
    if (change.version !== RUN_RULES_VERSION) throw new Error(`unsupported run-rules event version ${String(change.version)}`)
    if (change.kind === 'approved') state = { ...state, rules: mergeRules(state.rules, change.rules), approvedAtSeq: Number(event.seq) }
    else if (change.kind === 'accepted-call') {
      if (state.acceptedCallIds.has(change.callId)) continue
      state = { ...state, acceptedCallIds: new Set([...state.acceptedCallIds, change.callId]), counts: { ...state.counts, [change.tool]: (state.counts[change.tool] ?? 0) + 1 } }
    } else state = { ...state, refusals: [...state.refusals, change] }
  }
  return state
}
