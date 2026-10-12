import { createHash } from 'node:crypto'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

export const RUN_RULES_EVENT = 'viztools-run-rules/change' as const
export const RUN_RULES_VERSION = 3

/**
 * Approved narrowing rules.
 *
 * `allow` omitted means "no session allowlist" — only the deployment ceiling applies.
 * `allow: []` is an explicit, non-empty-intent allowlist that denies every governed tool.
 */
export interface RunRules {
  readonly version: 3
  readonly allow?: readonly string[]
  readonly deny: readonly string[]
  readonly limits: Readonly<Record<string, number>>
  readonly notes: readonly string[]
  readonly deploymentFingerprint: string
}

export type RunRulesRefusal = {
  readonly kind: 'refused-call' | 'limit-reached'
  readonly version: 3
  readonly callId: string
  readonly tool: string
  readonly reason: string
  readonly count?: number
  readonly limit?: number
}

export type RunRulesChange = {
  readonly kind: 'approved'
  readonly version: 3
  readonly callId: string
  readonly rules: RunRules
} | {
  /** A governed call passed every guard and its dispatch began. Counted whether it later succeeds or fails. */
  readonly kind: 'started-call'
  readonly version: 3
  readonly callId: string
  readonly tool: string
} | RunRulesRefusal

export interface RunRulesState {
  readonly rules?: RunRules
  readonly approvedAtSeq?: number
  readonly counts: Readonly<Record<string, number>>
  readonly startedCallIds: ReadonlySet<string>
  readonly refusals: readonly RunRulesRefusal[]
}

export function initialRunRulesState(): RunRulesState {
  return { counts: {}, startedCallIds: new Set(), refusals: [] }
}

export function deploymentFingerprint(allowedTools: readonly string[], maxLimits: Readonly<Record<string, number>>): string {
  return createHash('sha256').update(JSON.stringify({ allowedTools: [...allowedTools].sort(), maxLimits: Object.fromEntries(Object.entries(maxLimits).sort()) })).digest('hex')
}

/** Combine approvals so each new approval can only narrow: allowlists intersect, denylists union, limits take the minimum. */
export function mergeRules(previous: RunRules | undefined, proposed: RunRules): RunRules {
  if (previous === undefined) return proposed
  let allow: string[] | undefined
  if (previous.allow === undefined) allow = proposed.allow === undefined ? undefined : [...proposed.allow]
  else if (proposed.allow === undefined) allow = [...previous.allow]
  else {
    const prior = new Set(previous.allow)
    allow = proposed.allow.filter((tool) => prior.has(tool))
  }
  const deny = [...new Set([...previous.deny, ...proposed.deny])].sort()
  const limits: Record<string, number> = { ...previous.limits }
  for (const [tool, limit] of Object.entries(proposed.limits)) limits[tool] = limits[tool] === undefined ? limit : Math.min(limits[tool], limit)
  const { allow: _proposedAllow, ...rest } = proposed
  return { ...rest, ...(allow === undefined ? {} : { allow: [...new Set(allow)].sort() }), deny, limits, notes: [...new Set([...previous.notes, ...proposed.notes])] }
}

export function rulesValidForDeployment(rules: RunRules, allowedTools: ReadonlySet<string>, maxLimits: Readonly<Record<string, number>>): boolean {
  if ((rules.allow ?? []).some((tool) => !allowedTools.has(tool)) || rules.deny.some((tool) => !allowedTools.has(tool))) return false
  return Object.entries(rules.limits).every(([tool, limit]) => allowedTools.has(tool) && maxLimits[tool] !== undefined && limit <= maxLimits[tool])
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) throw new Error(`${label} must be a string array`)
  return [...value] as string[]
}

function decodeRules(value: unknown, legacy: boolean): RunRules {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('run rules must be an object')
  const record = value as Record<string, unknown>
  const limits: Record<string, number> = {}
  const rawLimits = record.limits
  if (typeof rawLimits !== 'object' || rawLimits === null || Array.isArray(rawLimits)) throw new Error('run rules limits must be an object')
  for (const [tool, limit] of Object.entries(rawLimits)) {
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1) throw new Error(`run rule limit for ${tool} must be a positive integer`)
    limits[tool] = limit
  }
  if (typeof record.deploymentFingerprint !== 'string') throw new Error('run rules require deploymentFingerprint')
  // Version 2 encoded "no session allowlist" as `allow: []`; preserve that recorded meaning.
  const allowRaw = record.allow === undefined ? undefined : stringArray(record.allow, 'run rules allow')
  const allow = legacy && allowRaw !== undefined && allowRaw.length === 0 ? undefined : allowRaw
  return {
    version: RUN_RULES_VERSION,
    ...(allow === undefined ? {} : { allow }),
    deny: stringArray(record.deny, 'run rules deny'),
    limits,
    notes: stringArray(record.notes ?? [], 'run rules notes'),
    deploymentFingerprint: record.deploymentFingerprint,
  }
}

/** Strictly decode one durable run-rules change; version 2 events are upgraded in memory. */
export function decodeRunRulesChange(data: unknown): RunRulesChange {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error('run-rules change must be an object')
  const record = data as Record<string, unknown>
  if (record.version !== RUN_RULES_VERSION && record.version !== 2) throw new Error(`unsupported run-rules event version ${String(record.version)}`)
  const legacy = record.version === 2
  if (typeof record.callId !== 'string' || record.callId.length === 0) throw new Error('run-rules change requires callId')
  const callId = record.callId
  if (record.kind === 'approved') return { kind: 'approved', version: RUN_RULES_VERSION, callId, rules: decodeRules(record.rules, legacy) }
  if (typeof record.tool !== 'string' || record.tool.length === 0) throw new Error('run-rules change requires tool')
  const tool = record.tool
  if (record.kind === 'started-call' || (legacy && record.kind === 'accepted-call')) return { kind: 'started-call', version: RUN_RULES_VERSION, callId, tool }
  if (record.kind === 'refused-call' || record.kind === 'limit-reached') {
    if (typeof record.reason !== 'string') throw new Error('run-rules refusal requires reason')
    return {
      kind: record.kind, version: RUN_RULES_VERSION, callId, tool, reason: record.reason,
      ...(typeof record.count === 'number' ? { count: record.count } : {}),
      ...(typeof record.limit === 'number' ? { limit: record.limit } : {}),
    }
  }
  throw new Error(`unknown run-rules change kind ${String(record.kind)}`)
}

/** Apply one decoded change. Shared by live updates and replay so both produce identical state. */
export function applyRunRulesChange(state: RunRulesState, change: RunRulesChange, seq: number): RunRulesState {
  if (change.kind === 'approved') return { ...state, rules: mergeRules(state.rules, change.rules), approvedAtSeq: seq }
  if (change.kind === 'started-call') {
    if (state.startedCallIds.has(change.callId)) return state
    return { ...state, startedCallIds: new Set([...state.startedCallIds, change.callId]), counts: { ...state.counts, [change.tool]: (state.counts[change.tool] ?? 0) + 1 } }
  }
  return { ...state, refusals: [...state.refusals, change] }
}

export function foldRunRules(events: readonly SessionEvent[]): RunRulesState {
  let state = initialRunRulesState()
  for (const event of events) {
    if (event.type !== RUN_RULES_EVENT) continue
    state = applyRunRulesChange(state, decodeRunRulesChange(event.data), Number(event.seq))
  }
  return state
}
