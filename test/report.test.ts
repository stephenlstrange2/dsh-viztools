import { describe, expect, it } from 'vitest'
import { completedReportKeys, reportKey, REPORT_EVENT } from '../src/report-domain.js'

describe('automatic report domain', () => {
  it('builds stable idempotency keys', () => {
    expect(reportKey('session-1', 42, 'v1')).toBe('session-1:42:v1')
  })

  it('treats available and failed outcomes as settled', () => {
    const events = [
      { type: REPORT_EVENT, seq: 0, time: 1, data: { kind: 'available', version: 1, triggerSeq: 4, trigger: 'tool:finalize', templateVersion: 'v1', notebook: 'n', html: 'h', inputs: 'i' } },
      { type: REPORT_EVENT, seq: 1, time: 2, data: { kind: 'failed', version: 1, triggerSeq: 5, trigger: 'turn:2', templateVersion: 'v1', reason: 'broken' } },
    ] as never
    expect(completedReportKeys(events, 's')).toEqual(new Set(['s:4:v1', 's:5:v1']))
  })

  it('allows a new template version for the same trigger', () => {
    const events = [
      { type: REPORT_EVENT, seq: 0, time: 1, data: { kind: 'available', version: 1, triggerSeq: 4, trigger: 'tool:finalize', templateVersion: 'v1', notebook: 'n', html: 'h', inputs: 'i' } },
    ] as never
    const settled = completedReportKeys(events, 's')
    expect(settled.has(reportKey('s', 4, 'v1'))).toBe(true)
    expect(settled.has(reportKey('s', 4, 'v2'))).toBe(false)
  })
})
