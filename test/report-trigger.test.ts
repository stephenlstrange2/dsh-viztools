import { describe, expect, it } from 'vitest'
import { matchTerminalResult, toolResultCallId, turnTriggerKey } from '../src/report-trigger.js'
import { otxToolResultContentBlock } from './fixtures/otx-events.js'

describe('durable report triggers', () => {
  it('reads call id from modern source/content-block result', () => {
    expect(toolResultCallId(otxToolResultContentBlock as never)).toBe('finalize-1')
  })

  it('matches only the pending terminal call', () => {
    const pending = new Map([['finalize-1', { callId: 'finalize-1', tool: 'mcp__otx__finalize_run' }]])
    expect(matchTerminalResult(otxToolResultContentBlock as never, pending)?.tool).toBe('mcp__otx__finalize_run')
  })

  it('coalesces turn identity independently of changing session seq', () => {
    expect(turnTriggerKey('s', 4, 'v1')).toBe(turnTriggerKey('s', 4, 'v1'))
    expect(turnTriggerKey('s', 4, 'v1')).not.toBe(turnTriggerKey('s', 5, 'v1'))
  })
})
