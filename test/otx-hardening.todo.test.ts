import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { approvedGateChange, otxFinalizeCall, otxPtcStart, otxToolResultContentBlock } from './fixtures/otx-events.js'

/**
 * Phase-0 release blockers. Every todo is an acceptance test that must be
 * implemented and made green before locked-console promotion. `it.todo` keeps
 * the ordinary developer suite usable while exposing the unfinished security
 * contract in test output.
 */
describe('OTX hardening release blockers', () => {

  it('PTC plan transport can run while non-planning tools stay closed', async () => {
    const { decideTool } = await import('../src/gate-policy.js')
    const planning = new Set(['run_code', 'exit_plan_mode', 'bench_status'])
    const allowed = new Set(['run_code', 'exit_plan_mode', 'bench_status', 'emit_otx'])
    const base = { knownAgent: true, planApproved: false, planningTools: planning, deploymentAllowed: allowed, deploymentLimits: {}, counts: {} }
    expect(decideTool({ ...base, tool: 'run_code' })).toBeUndefined()
    expect(decideTool({ ...base, tool: 'exit_plan_mode' })).toBeUndefined()
    expect(decideTool({ ...base, tool: 'emit_otx' })?.code).toBe('PLAN_NOT_APPROVED')
  })



  it('keeps realistic modern DSH and PTC fixture shapes', () => {
    expect(otxToolResultContentBlock.data.message.content[0].isError).toBe(false)
    expect(otxToolResultContentBlock.data.message.source.callId).toBe('finalize-1')
    expect(otxFinalizeCall.data.name).toBe('mcp__otx__finalize_run')
    expect(otxPtcStart.data.subCallId).toBe('ptc-1')
    expect(approvedGateChange.data.kind).toBe('approved')
  })

  it('preserves content-block loader handling required by real OTX logs', () => {
    const source = readFileSync(new URL('../python/dsh_viztools/session.py', import.meta.url), 'utf8')
    expect(source).toContain('any(b.get("isError") is True for b in blocks)')
    expect(source).toContain('message.get("source")')
  })
})
