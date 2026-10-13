import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { toolResultCallId } from './report-trigger.js'
import { decodeRunRulesChange, mergeRules, type RunRules } from './run-rules.js'
import type { StoredRecord, StoreSnapshot } from './state-store.js'

/** Record kinds the gate writes to its `gate` channel. */
export type GateRecordKind = 'plan-approved' | 'refused' | 'rules-approved' | 'rules-invalidated' | 'started' | 'not-started' | 'reset'

export interface GateRefusal {
  readonly callId: string
  readonly tool: string
  readonly code: string
  readonly reason: string
  readonly count?: number
  readonly limit?: number
  /** Whether the plan was still unapproved when the call was refused. */
  readonly beforeApproval: boolean
  readonly t: number
}

export interface GateFold {
  readonly approved: boolean
  readonly approvedAt?: number
  readonly planCallId?: string
  readonly rules?: RunRules
  /** Set when saved rules can no longer be honoured: every governed tool is refused. */
  readonly rulesInvalid?: string
  readonly counts: Readonly<Record<string, number>>
  readonly started: ReadonlySet<string>
  /** Calls with a recorded decision (started, not started, or refused). */
  readonly decided: ReadonlySet<string>
  readonly refusals: readonly GateRefusal[]
}

export function initialGateFold(): GateFold {
  return { approved: false, counts: {}, started: new Set(), decided: new Set(), refusals: [] }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Apply one record. Live updates and replay share this function, so both agree exactly. */
export function applyGateRecord(state: GateFold, record: Pick<StoredRecord, 'kind' | 'data' | 't'>): GateFold {
  const data = record.data as Record<string, unknown>
  switch (record.kind) {
    case 'reset': {
      // Damaged history before this point: approval is void and rules fail closed until a
      // fresh approval is recorded after the reset.
      const { approvedAt: _approvedAt, planCallId: _planCallId, ...rest } = state
      return { ...rest, approved: false, rulesInvalid: str(data.reason) ?? 'plugin state was damaged' }
    }
    case 'plan-approved':
      { const planCallId = str(data.planCallId); return { ...state, approved: true, approvedAt: record.t, ...(planCallId === undefined ? {} : { planCallId }) } }
    case 'rules-approved': {
      const decoded = decodeRunRulesChange({ kind: 'approved', version: 3, callId: str(data.callId) ?? 'rules', rules: data.rules })
      if (decoded.kind !== 'approved') return state
      // After invalidation the stale rules are unusable; a fresh approval replaces them.
      const rules = state.rulesInvalid !== undefined ? decoded.rules : mergeRules(state.rules, decoded.rules)
      const { rulesInvalid: _invalid, ...rest } = state
      return { ...rest, rules }
    }
    case 'rules-invalidated':
      return { ...state, rulesInvalid: str(data.reason) ?? 'saved run rules are invalid' }
    case 'started': {
      const callId = str(data.callId)
      const tool = str(data.tool)
      if (callId === undefined || tool === undefined || state.started.has(callId)) return state
      return { ...state, started: new Set([...state.started, callId]), decided: new Set([...state.decided, callId]), counts: { ...state.counts, [tool]: (state.counts[tool] ?? 0) + 1 } }
    }
    case 'not-started': {
      const callId = str(data.callId)
      const tool = str(data.tool)
      if (callId === undefined || tool === undefined) return state
      const decided = new Set([...state.decided, callId])
      if (!state.started.has(callId)) return { ...state, decided }
      const started = new Set(state.started)
      started.delete(callId)
      return { ...state, decided, started, counts: { ...state.counts, [tool]: Math.max(0, (state.counts[tool] ?? 0) - 1) } }
    }
    case 'refused': {
      const callId = str(data.callId)
      const tool = str(data.tool)
      if (callId === undefined || tool === undefined) return state
      const refusal: GateRefusal = {
        callId, tool, code: str(data.code) ?? 'REFUSED', reason: str(data.reason) ?? 'refused', t: record.t,
        beforeApproval: data.beforeApproval === true,
        ...(typeof data.count === 'number' ? { count: data.count } : {}),
        ...(typeof data.limit === 'number' ? { limit: data.limit } : {}),
      }
      return { ...state, decided: new Set([...state.decided, callId]), refusals: [...state.refusals, refusal] }
    }
    default:
      return state
  }
}

export function foldGateRecords(records: readonly Pick<StoredRecord, 'kind' | 'data' | 't'>[]): GateFold {
  let state = initialGateFold()
  for (const record of records) state = applyGateRecord(state, record)
  return state
}

export interface GateTrust {
  /** Counts for limited tools may be honoured. Once lost, never restored for the session. */
  readonly countsTrusted: boolean
  /** The store was damaged and no reset has been recorded yet: void approval and rules now. */
  readonly needsReset: boolean
  /** The store is absent although the session log shows gated activity. */
  readonly missing: boolean
  readonly reason?: string
}

/** Completed calls (with a durable result) recorded in the session log, native and PTC. */
export function completedCalls(events: readonly SessionEvent[]): { callId: string; tool: string }[] {
  const names = new Map<string, string>()
  const done = new Set<string>()
  const out: { callId: string; tool: string }[] = []
  for (const event of events) {
    const data = event.data as unknown as Record<string, unknown>
    if (event.type === 'tool/call' && typeof data.callId === 'string' && typeof data.name === 'string') names.set(data.callId, data.name)
    else if (event.type === 'tool/ptc-dispatch' && typeof data.subCallId === 'string' && typeof data.name === 'string') out.push({ callId: data.subCallId, tool: data.name })
    else {
      const callId = toolResultCallId(event)
      if (callId !== undefined && !done.has(callId)) { done.add(callId); const tool = names.get(callId); if (tool !== undefined) out.push({ callId, tool }) }
    }
  }
  return out
}

/** Whether the session log shows a successful plan approval (exit_plan_mode result without error). */
function loggedPlanApproval(events: readonly SessionEvent[]): boolean {
  const exits = new Set<string>()
  for (const event of events) {
    const data = event.data as unknown as Record<string, unknown>
    if (event.type === 'tool/call' && data.name === 'exit_plan_mode' && typeof data.callId === 'string') exits.add(data.callId)
    if (event.type !== 'tool/result') continue
    const callId = toolResultCallId(event)
    const message = data.message as Record<string, unknown> | undefined
    if (callId !== undefined && exits.has(callId) && message?.isError !== true) return true
  }
  return false
}

/**
 * Cross-check the plugin store against the (independently durable) session log and fail
 * closed. A damaged or missing store voids approval and rules (via a reset); counts for
 * limited tools are trusted only when the store is intact AND every completed call of a
 * limited tool in the session log has a recorded decision.
 */
export function evaluateTrust(events: readonly SessionEvent[], snapshot: StoreSnapshot, fold: GateFold, limitedTools: ReadonlySet<string>): GateTrust {
  const undecided = completedCalls(events).filter((call) => limitedTools.has(call.tool) && !fold.decided.has(call.callId))
  if (snapshot.integrity.status !== 'ok') {
    return { countsTrusted: false, needsReset: !snapshot.resynced, missing: false, reason: `dsh-viztools gate state is ${snapshot.integrity.status} (${snapshot.integrity.reason})` }
  }
  if (!snapshot.exists && (undecided.length > 0 || loggedPlanApproval(events))) {
    return { countsTrusted: false, needsReset: false, missing: true, reason: 'dsh-viztools gate state for this session is missing' }
  }
  if (undecided.length > 0) {
    return { countsTrusted: false, needsReset: false, missing: false, reason: `dsh-viztools gate state has no decision for ${undecided.length} completed limited call(s)` }
  }
  return { countsTrusted: true, needsReset: false, missing: false }
}
