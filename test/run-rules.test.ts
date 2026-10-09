import { describe, expect, it } from 'vitest'
import { deploymentFingerprint, foldRunRules, mergeRules, rulesValidForDeployment, RUN_RULES_EVENT, type RunRules } from '../src/run-rules.js'

const fingerprint = deploymentFingerprint(['mcp__otx__diff', 'mcp__otx__emit', 'read'], { read: 2 })
const rules: RunRules = { version: 2, allow: ['mcp__otx__diff', 'read'], deny: ['mcp__otx__emit'], limits: { read: 2 }, notes: ['no edits'], deploymentFingerprint: fingerprint }
function event(type: string, seq: number, data: unknown) { return { type, seq, time: seq, data } as never }

describe('approved run rules', () => {
  it('merges successive approvals monotonically', () => {
    const tighter: RunRules = { ...rules, allow: ['read'], deny: ['mcp__otx__diff'], limits: { read: 1 }, notes: ['second'] }
    expect(mergeRules(rules, tighter)).toMatchObject({ allow: ['read'], deny: ['mcp__otx__diff', 'mcp__otx__emit'], limits: { read: 1 }, notes: ['no edits', 'second'] })
  })

  it('counts only durable accepted-call events and deduplicates call ids', () => {
    const state = foldRunRules([
      event(RUN_RULES_EVENT, 0, { kind: 'approved', version: 2, callId: 'r', rules }),
      event('tool/call', 1, { callId: 'ignored', name: 'read' }),
      event(RUN_RULES_EVENT, 2, { kind: 'accepted-call', version: 2, callId: 'a', tool: 'read' }),
      event(RUN_RULES_EVENT, 3, { kind: 'accepted-call', version: 2, callId: 'a', tool: 'read' }),
      event(RUN_RULES_EVENT, 4, { kind: 'limit-reached', version: 2, callId: 'b', tool: 'read', reason: 'limit', count: 1, limit: 1 }),
    ])
    expect(state.counts.read).toBe(1)
    expect(state.refusals).toHaveLength(1)
  })

  it('rejects saved rules under a stricter deployment', () => {
    expect(rulesValidForDeployment(rules, new Set(['read']), { read: 1 })).toBe(false)
    expect(rulesValidForDeployment({ ...rules, allow: ['read'], deny: [], limits: { read: 1 } }, new Set(['read']), { read: 1 })).toBe(true)
  })
})
