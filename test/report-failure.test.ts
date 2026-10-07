import { describe, expect, it } from 'vitest'
import { Session } from '@deepseek-ai/dsh-session'
import { completedReportKeys, REPORT_EVENT } from '../src/report-domain.js'

describe('report failure durability', () => {
  it('accepts a durable failed outcome and prevents retry for the same key', () => {
    const session = Session.create('report-session' as never)
    session.append(REPORT_EVENT, {
      kind: 'failed', version: 1, triggerSeq: 8, trigger: 'tool:finalize_run', templateVersion: 'broken-v1', reason: 'template failed',
    })
    expect(completedReportKeys(session.snapshotEvents(), 'report-session').has('report-session:8:broken-v1')).toBe(true)
  })
})
