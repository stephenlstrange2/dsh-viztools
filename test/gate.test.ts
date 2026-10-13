import { describe, expect, it } from 'vitest'
import { resolveGateConfig } from '../src/gate.js'
import { foldGate, GATE_EVENT_TYPE, initialGateState } from '../src/gate-domain.js'

function event(seq: number, data: Record<string, unknown>) {
  return {
    type: GATE_EVENT_TYPE,
    seq,
    time: 1_000 + seq,
    data,
  } as never
}

describe('legacy in-log gate domain (migration only)', () => {
  it('starts closed', () => {
    expect(initialGateState()).toEqual({ approved: false, refusals: 0 })
  })

  it('folds refusals and approval', () => {
    const state = foldGate([
      event(0, { kind: 'refused', version: 1, callId: 'c1', tool: 'emit_otx', reason: 'Plan not approved yet.' }),
      event(1, { kind: 'approved', version: 1, planCallId: 'plan-1' }),
    ])
    expect(state).toEqual({ approved: true, approvedAtSeq: 1, planCallId: 'plan-1', refusals: 1 })
  })

  it('preserves closed state when no approval exists on resume', () => {
    const state = foldGate([
      event(0, { kind: 'refused', version: 1, callId: 'c1', tool: 'finalize_run', reason: 'Plan not approved yet.' }),
    ])
    expect(state).toEqual({ approved: false, refusals: 1 })
  })

  it('rejects malformed durable changes', () => {
    expect(() => foldGate([event(0, { kind: 'approved', version: 2, planCallId: 'x' })])).toThrow(/unsupported/)
  })

  it('normalizes duplicate planning tools', () => {
    expect(resolveGateConfig({
      planFirst: { enabled: true, planningTools: [' read ', 'read', 'grep'], denialMessage: ' denied ' },
      runRules: { enabled: false, allowedTools: [], maxLimits: {} },
    })).toMatchObject({
      planFirst: { enabled: true, planningTools: ['read', 'grep'], denialMessage: 'denied', allowPtcTransport: false },
      runRules: { enabled: false, allowedTools: [], maxLimits: {} },
      delegation: { allow: false },
      stateDir: '.dsh/viztools/state',
    })
  })

  it('rejects widening run rules configuration and bad caps', () => {
    expect(() => resolveGateConfig({
      planFirst: { enabled: false, planningTools: [], denialMessage: 'denied' },
      runRules: { enabled: true, allowedTools: ['read'], maxLimits: { bash: 1 } },
    })).toThrow(/outside allowedTools/)
    expect(() => resolveGateConfig({
      planFirst: { enabled: false, planningTools: [], denialMessage: 'denied' },
      runRules: { enabled: true, allowedTools: ['read'], maxLimits: { read: 0 } },
    })).toThrow(/positive integer/)
  })

  it('rejects blank planning tools and messages', () => {
    expect(() => resolveGateConfig({
      planFirst: { enabled: true, planningTools: [''], denialMessage: 'denied' },
      runRules: { enabled: false, allowedTools: [], maxLimits: {} },
    })).toThrow(/non-empty/)
    expect(() => resolveGateConfig({
      planFirst: { enabled: true, planningTools: [], denialMessage: '   ' },
      runRules: { enabled: false, allowedTools: [], maxLimits: {} },
    })).toThrow(/denialMessage/)
  })
})
