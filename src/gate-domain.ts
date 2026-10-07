import type { SessionEvent } from '@deepseek-ai/dsh-session'

export const GATE_EVENT_VERSION = 1
export const GATE_EVENT_TYPE = 'viztools-gate/change' as const

export interface GateApprovedChange {
  readonly kind: 'approved'
  readonly version: 1
  readonly planCallId: string
}

export interface GateRefusedChange {
  readonly kind: 'refused'
  readonly version: 1
  readonly callId: string
  readonly tool: string
  readonly reason: string
}

export type GateChange = GateApprovedChange | GateRefusedChange

export interface GateState {
  readonly approved: boolean
  readonly approvedAtSeq?: number
  readonly planCallId?: string
  readonly refusals: number
}

export function initialGateState(): GateState {
  return { approved: false, refusals: 0 }
}

export function decodeGateChange(event: SessionEvent): GateChange | undefined {
  if (event.type !== GATE_EVENT_TYPE) return undefined
  const value = event.data as unknown
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('viztools gate change must be an object')
  }
  const record = value as Record<string, unknown>
  if (record.version !== GATE_EVENT_VERSION) throw new Error(`unsupported viztools gate event version ${String(record.version)}`)
  if (record.kind === 'approved') {
    if (typeof record.planCallId !== 'string' || record.planCallId.length === 0) throw new Error('approved gate change requires planCallId')
    return { kind: 'approved', version: 1, planCallId: record.planCallId }
  }
  if (record.kind === 'refused') {
    if (typeof record.callId !== 'string' || record.callId.length === 0) throw new Error('refused gate change requires callId')
    if (typeof record.tool !== 'string' || record.tool.length === 0) throw new Error('refused gate change requires tool')
    if (typeof record.reason !== 'string' || record.reason.length === 0) throw new Error('refused gate change requires reason')
    return { kind: 'refused', version: 1, callId: record.callId, tool: record.tool, reason: record.reason }
  }
  throw new Error(`unknown viztools gate change kind ${String(record.kind)}`)
}

export function foldGate(events: readonly SessionEvent[]): GateState {
  let state = initialGateState()
  for (const event of events) {
    const change = decodeGateChange(event)
    if (change === undefined) continue
    if (change.kind === 'approved') {
      state = { ...state, approved: true, approvedAtSeq: Number(event.seq), planCallId: change.planCallId }
    } else {
      state = { ...state, refusals: state.refusals + 1 }
    }
  }
  return state
}
