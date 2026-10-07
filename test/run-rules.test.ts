import { describe, expect, it } from 'vitest'
import { foldRunRules, matchesTool, RUN_RULES_EVENT, toolAllowed, type RunRules } from '../src/run-rules.js'

const rules: RunRules = {
  version: 1,
  allow: ['mcp__otx__*', 'read'],
  deny: ['mcp__otx__emit'],
  limits: { read: 2 },
  notes: ['no edits after step 40'],
}

function event(type: string, seq: number, data: unknown) {
  return { type, seq, time: seq, data } as never
}

describe('approved run rules', () => {
  it('matches exact and prefix patterns', () => {
    expect(matchesTool('mcp__otx__*', 'mcp__otx__diff')).toBe(true)
    expect(matchesTool('read', 'read')).toBe(true)
    expect(matchesTool('read', 'read_file')).toBe(false)
  })

  it('applies deny before allow', () => {
    expect(toolAllowed(rules, 'mcp__otx__diff')).toBe(true)
    expect(toolAllowed(rules, 'mcp__otx__emit')).toBe(false)
    expect(toolAllowed(rules, 'bash')).toBe(false)
  })

  it('folds approved rules, durable counts, and refusals', () => {
    const state = foldRunRules([
      event(RUN_RULES_EVENT, 0, { kind: 'approved', version: 1, callId: 'r', rules }),
      event('tool/call', 1, { callId: 'a', name: 'read', arguments: '{}' }),
      event('tool/ptc-dispatch-start', 2, { subCallId: 'b', name: 'read', arguments: {} }),
      event(RUN_RULES_EVENT, 3, { kind: 'limit-reached', version: 1, callId: 'c', tool: 'read', reason: 'limit', count: 2, limit: 2 }),
    ])
    expect(state.rules).toEqual(rules)
    expect(state.counts.read).toBe(2)
    expect(state.refusals).toHaveLength(1)
  })
})
