import { describe, expect, it } from 'vitest'
import { completedReportKeysFromRecords } from '../src/report-domain.js'

describe('report failure durability', () => {
  it('treats a durable failed outcome on the report channel as settled for the same key', () => {
    const records = [{ kind: 'failed', data: { version: 1, triggerSeq: 8, trigger: 'tool:finalize_run', templateVersion: 'broken-v1', reason: 'template failed' } }]
    expect(completedReportKeysFromRecords(records, 'report-session').has('report-session:8:broken-v1')).toBe(true)
    expect(completedReportKeysFromRecords(records, 'report-session').has('report-session:8:fixed-v2')).toBe(false)
  })
})
