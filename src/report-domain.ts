import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** LEGACY in-log event type (dsh-viztools <= ca3b3ca); now stored on the `report` plugin channel. */
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

/** Settled report keys from report-channel records (`{ kind, data }`). */
export function completedReportKeysFromRecords(records: readonly { readonly kind: string; readonly data: unknown }[], sessionId: string): Set<string> {
  const keys = new Set<string>()
  for (const record of records) {
    if (record.kind !== 'available' && record.kind !== 'failed') continue
    const data = record.data as { triggerSeq?: unknown; templateVersion?: unknown }
    if (typeof data.triggerSeq === 'number' && typeof data.templateVersion === 'string') keys.add(reportKey(sessionId, data.triggerSeq, data.templateVersion))
  }
  return keys
}

/** LEGACY: settled keys from in-log `viztools-report/change` events (migration only). */
export function completedReportKeys(events: readonly SessionEvent[], sessionId: string): Set<string> {
  const records = events
    .filter((event) => (event.type as string) === REPORT_EVENT)
    .map((event) => { const data = (event as { data: unknown }).data as ReportChange; return { kind: data.kind, data } })
  return completedReportKeysFromRecords(records, sessionId)
}
