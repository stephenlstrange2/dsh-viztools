import { describe, expect, it } from 'vitest'
import { decideTool, expandPatterns } from '../src/gate-policy.js'

const planning = new Set(['bench_status', 'exit_plan_mode'])
const allowed = new Set(['bench_status', 'exit_plan_mode', 'replay_tx_only', 'diff'])

describe('monotonic gate policy', () => {
  it('fails closed for unknown agent state', () => {
    expect(decideTool({ knownAgent: false, planApproved: false, planningTools: planning, deploymentAllowed: allowed, deploymentLimits: {}, counts: {}, tool: 'bench_status' })?.code).toBe('GATE_STATE_UNAVAILABLE')
  })

  it('denies non-planning tools before approval', () => {
    expect(decideTool({ knownAgent: true, planApproved: false, planningTools: planning, deploymentAllowed: allowed, deploymentLimits: {}, counts: {}, tool: 'diff' })?.code).toBe('PLAN_NOT_APPROVED')
  })

  it('enforces deployment allowedTools with no session rules', () => {
    expect(decideTool({ knownAgent: true, planApproved: true, planningTools: planning, deploymentAllowed: allowed, deploymentLimits: {}, counts: {}, tool: 'bash' })?.code).toBe('DEPLOYMENT_TOOL_DENIED')
  })

  it('applies deployment limits without session limits', () => {
    expect(decideTool({ knownAgent: true, planApproved: true, planningTools: planning, deploymentAllowed: allowed, deploymentLimits: { replay_tx_only: 2 }, counts: { replay_tx_only: 2 }, tool: 'replay_tx_only' })?.code).toBe('RUN_RULE_LIMIT')
  })

  it('rejects wildcards that overlap deployment-denied tools', () => {
    expect(() => expandPatterns(['r*'], ['replay_tx_only', 'read', 'run_code'], new Set(['replay_tx_only']))).toThrow(/deployment-denied/)
  })

  it('stores safe wildcard expansion as canonical names', () => {
    expect(expandPatterns(['mcp__otx__*'], ['mcp__otx__diff', 'mcp__otx__replay'], new Set(['mcp__otx__diff', 'mcp__otx__replay']))).toEqual(['mcp__otx__diff', 'mcp__otx__replay'])
  })
})
