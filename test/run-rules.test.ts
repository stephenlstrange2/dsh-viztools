import { describe, expect, it } from 'vitest'
import { deploymentFingerprint, foldRunRules, mergeRules, rulesValidForDeployment, RUN_RULES_EVENT, type RunRules } from '../src/run-rules.js'
import { decideTool } from '../src/gate-policy.js'

const fingerprint = deploymentFingerprint(['mcp__otx__diff', 'mcp__otx__emit', 'read'], { read: 2 })
const rules: RunRules = { version: 3, allow: ['mcp__otx__diff', 'read'], deny: ['mcp__otx__emit'], limits: { read: 2 }, notes: ['no edits'], deploymentFingerprint: fingerprint }
function event(type: string, seq: number, data: unknown) { return { type, seq, time: seq, data } as never }

describe('approved run rules', () => {
  it('merges successive approvals monotonically', () => {
    const tighter: RunRules = { ...rules, allow: ['read'], deny: ['mcp__otx__diff'], limits: { read: 1 }, notes: ['second'] }
    expect(mergeRules(rules, tighter)).toMatchObject({ allow: ['read'], deny: ['mcp__otx__diff', 'mcp__otx__emit'], limits: { read: 1 }, notes: ['no edits', 'second'] })
  })

  it('keeps a disjoint allowlist intersection empty, which denies every tool', () => {
    const disjoint: RunRules = { ...rules, allow: ['mcp__otx__emit'] }
    const merged = mergeRules({ ...rules, allow: ['read'] }, disjoint)
    expect(merged.allow).toEqual([])
    const input = { knownAgent: true, planFirst: false, planApproved: false, planningTools: new Set<string>(), deploymentAllowed: new Set(['read', 'mcp__otx__emit']), deploymentLimits: {}, counts: {}, rules: merged }
    expect(decideTool({ ...input, tool: 'read' })?.code).toBe('RUN_RULE_DENIED')
    expect(decideTool({ ...input, tool: 'mcp__otx__emit' })?.code).toBe('RUN_RULE_DENIED')
  })

  it('distinguishes an absent allowlist from an empty one', () => {
    const { allow: _allow, ...open } = rules
    const absent: RunRules = open
    expect(mergeRules(absent, absent).allow).toBeUndefined()
    expect(mergeRules(absent, { ...absent, allow: [] }).allow).toEqual([])
    const input = { knownAgent: true, planFirst: false, planApproved: false, planningTools: new Set<string>(), deploymentAllowed: new Set(['read']), deploymentLimits: {}, counts: {}, tool: 'read' }
    expect(decideTool({ ...input, rules: absent })).toBeUndefined()
    expect(decideTool({ ...input, rules: { ...absent, allow: [] } })?.code).toBe('RUN_RULE_DENIED')
  })

  it('counts only durable started-call events and deduplicates call ids', () => {
    const state = foldRunRules([
      event(RUN_RULES_EVENT, 0, { kind: 'approved', version: 3, callId: 'r', rules }),
      event('tool/call', 1, { callId: 'ignored', name: 'read' }),
      event(RUN_RULES_EVENT, 2, { kind: 'started-call', version: 3, callId: 'a', tool: 'read' }),
      event(RUN_RULES_EVENT, 3, { kind: 'started-call', version: 3, callId: 'a', tool: 'read' }),
      event(RUN_RULES_EVENT, 4, { kind: 'limit-reached', version: 3, callId: 'b', tool: 'read', reason: 'limit', count: 1, limit: 1 }),
    ])
    expect(state.counts.read).toBe(1)
    expect(state.refusals).toHaveLength(1)
  })

  it('replays legacy version 2 logs with their recorded meaning', () => {
    const state = foldRunRules([
      event(RUN_RULES_EVENT, 0, { kind: 'approved', version: 2, callId: 'r', rules: { ...rules, version: 2, allow: [] } }),
      event(RUN_RULES_EVENT, 1, { kind: 'accepted-call', version: 2, callId: 'a', tool: 'read' }),
    ])
    expect(state.rules?.allow).toBeUndefined()
    expect(state.counts.read).toBe(1)
  })

  it('rejects unknown versions and kinds', () => {
    expect(() => foldRunRules([event(RUN_RULES_EVENT, 0, { kind: 'approved', version: 9, callId: 'r', rules })])).toThrow(/unsupported/)
    expect(() => foldRunRules([event(RUN_RULES_EVENT, 0, { kind: 'accepted-call', version: 3, callId: 'r', tool: 'read' })])).toThrow(/unknown/)
  })

  it('rejects saved rules under a stricter deployment', () => {
    expect(rulesValidForDeployment(rules, new Set(['read']), { read: 1 })).toBe(false)
    expect(rulesValidForDeployment({ ...rules, allow: ['read'], deny: [], limits: { read: 1 } }, new Set(['read']), { read: 1 })).toBe(true)
  })
})
