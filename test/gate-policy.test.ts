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

  it('refuses delegation unless the deployment opts in, even when the tool is allowed', () => {
    const withDelegation = new Set([...allowed, 'subagent', 'subagent_fork', 'workflow'])
    for (const tool of ['subagent', 'subagent_fork', 'workflow']) {
      expect(decideTool({ knownAgent: true, planApproved: true, planningTools: planning, deploymentAllowed: withDelegation, deploymentLimits: {}, counts: {}, tool })?.code).toBe('DELEGATION_DENIED')
      expect(decideTool({ knownAgent: true, planFirst: false, planApproved: false, planningTools: planning, deploymentAllowed: withDelegation, deploymentLimits: {}, counts: {}, tool })?.code).toBe('DELEGATION_DENIED')
    }
    expect(decideTool({ knownAgent: true, planApproved: true, planningTools: planning, deploymentAllowed: withDelegation, deploymentLimits: {}, counts: {}, tool: 'subagent', delegationAllowed: true })).toBeUndefined()
  })

  it('refuses every governed tool when saved rules are invalid and limited tools when counts are untrusted', () => {
    const base = { knownAgent: true, planApproved: true, planningTools: planning, deploymentAllowed: allowed, deploymentLimits: { replay_tx_only: 3 }, counts: {} }
    expect(decideTool({ ...base, tool: 'diff', rulesInvalid: 'Saved run rules no longer fit this deployment' })?.code).toBe('RUN_RULES_INVALID')
    expect(decideTool({ ...base, tool: 'replay_tx_only', countsUntrusted: 'state truncated' })?.code).toBe('COUNTS_UNTRUSTED')
    expect(decideTool({ ...base, tool: 'diff', countsUntrusted: 'state truncated' })).toBeUndefined()
  })

  it('plan-first only: approval opens every tool with no deployment allowlist', () => {
    const base = { knownAgent: true, planFirst: true, planningTools: planning, deploymentRestricted: false, deploymentAllowed: new Set<string>(), deploymentLimits: {}, counts: {}, denialMessage: 'Submit a plan first.' }
    expect(decideTool({ ...base, planApproved: false, tool: 'bash' })).toEqual({ code: 'PLAN_NOT_APPROVED', reason: 'Submit a plan first.' })
    expect(decideTool({ ...base, planApproved: true, tool: 'bash' })).toBeUndefined()
  })

  it('run-rules only: no plan approval is required, deployment ceiling applies', () => {
    const base = { knownAgent: true, planFirst: false, planApproved: false, planningTools: new Set<string>(), deploymentAllowed: allowed, deploymentLimits: {}, counts: {} }
    expect(decideTool({ ...base, tool: 'diff' })).toBeUndefined()
    expect(decideTool({ ...base, tool: 'bash' })?.code).toBe('DEPLOYMENT_TOOL_DENIED')
  })

  it('always allows gate control tools, including before approval', () => {
    const control = new Set(['exit_plan_mode', 'propose_run_rules', 'run_code'])
    for (const tool of control) {
      expect(decideTool({ knownAgent: true, planFirst: true, planApproved: false, planningTools: new Set(), controlTools: control, deploymentAllowed: new Set(), deploymentLimits: {}, counts: {}, tool })).toBeUndefined()
    }
  })

  it('keeps planning tools under the deployment ceiling and session rules after approval', () => {
    const rules = { version: 3 as const, deny: ['bench_status'], limits: {}, notes: [], deploymentFingerprint: 'x' }
    expect(decideTool({ knownAgent: true, planApproved: true, planningTools: planning, deploymentAllowed: allowed, deploymentLimits: {}, rules, counts: {}, tool: 'bench_status' })?.code).toBe('RUN_RULE_DENIED')
  })

  it('stores safe wildcard expansion as canonical names', () => {
    expect(expandPatterns(['mcp__otx__*'], ['mcp__otx__diff', 'mcp__otx__replay'], new Set(['mcp__otx__diff', 'mcp__otx__replay']))).toEqual(['mcp__otx__diff', 'mcp__otx__replay'])
  })
})
