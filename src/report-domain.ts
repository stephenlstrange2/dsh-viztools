import type { SessionEvent } from '@deepseek-ai/dsh-session'

export const REPORT_EVENT = 'viztools-report/change' as const
export const REPORT_VERSION = 1

export type ReportChange = {
  readonly kind: 'available'
  readonly version: 1
  readonly triggerSeq: number
  readonly trigger: string
  readonly templateVersion: string
  readonly notebook: string
  readonly html: string
  readonly inputs: string
} | {
  readonly kind: 'failed'
  readonly version: 1
  readonly triggerSeq: number
  readonly trigger: string
  readonly templateVersion: string
  readonly reason: string
}

export function reportKey(sessionId: string, triggerSeq: number, templateVersion: string): string {
  return `${sessionId}:${triggerSeq}:${templateVersion}`
}

export function completedReportKeys(events: readonly SessionEvent[], sessionId: string): Set<string> {
  const keys = new Set<string>()
  for (const event of events) {
    if (event.type !== REPORT_EVENT) continue
    const change = event.data as unknown as ReportChange
    if (change.kind === 'available' || change.kind === 'failed') keys.add(reportKey(sessionId, change.triggerSeq, change.templateVersion))
  }
  return keys
}
