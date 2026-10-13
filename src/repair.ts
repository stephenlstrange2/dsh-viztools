import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { decodeGateChange } from './gate-domain.js'
import { isSafeSessionId } from './managed-state.js'
import { decodeRunRulesChange } from './run-rules.js'
import { createSidecarStore, type JsonValue, type StoreChannel } from './state-store.js'

/**
 * Repair DSH session logs written by dsh-viztools <= ca3b3ca.
 *
 * Those versions appended `viztools-gate/change`, `viztools-run-rules/change`, and
 * `viztools-report/change` events without the `ignorable` marker. DSH 0.2.0-rc.2 refuses to
 * reopen such logs. The repair:
 *
 * 1. backs up the log next to the original (the projection cache is left untouched);
 * 2. exports the legacy events into the plugin sidecar (unless one already exists);
 * 3. marks each legacy event `ignorable: true` IN PLACE. Events are not deleted: other
 *    events reference sequence numbers (`sourceEventSeqs`, surface replacements), so removal
 *    would renumber the log and corrupt it.
 *
 * Stop every DSH process that uses the DSH home before running it without `dryRun`.
 */

export const LEGACY_EVENT_TYPES: ReadonlySet<string> = new Set(['viztools-gate/change', 'viztools-run-rules/change', 'viztools-report/change'])

export interface RepairOptions {
  /** DSH home whose `sessions/` tree is scanned. */
  readonly dshHome: string
  /** Workspace (console cwd) whose plugin state directory receives exported records. */
  readonly workspace: string
  readonly stateDir?: string
  /** Restrict to these session ids. */
  readonly sessions?: readonly string[]
  readonly dryRun: boolean
  /** zstd executable for `.jsonl.zstd` logs. */
  readonly zstd?: string
  readonly now?: () => number
}

export interface RepairedSession {
  readonly sessionId: string
  readonly log: string
  readonly legacyEvents: number
  readonly action: 'converted' | 'would-convert' | 'clean' | 'failed'
  readonly exported: { readonly gate: number; readonly report: number; readonly skipped?: string }
  readonly backup?: string
  readonly error?: string
}

type RawEvent = Record<string, unknown> & { type?: unknown; seq?: unknown; data?: unknown; ignorable?: unknown }

function findLogs(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    let entries: import('node:fs').Dirent[]
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/^session\.v\d+\.jsonl(\.zstd)?$/.test(entry.name)) out.push(path)
    }
  }
  walk(root)
  return out.sort()
}

function readLog(path: string, zstd: string): string {
  return path.endsWith('.zstd') ? execFileSync(zstd, ['-dc', '--', path], { maxBuffer: 1 << 30 }).toString('utf8') : readFileSync(path, 'utf8')
}

/**
 * DSH writes zstd logs as concatenated frames whose FIRST frame holds only the header line;
 * its session lister decodes just that frame. Preserve the layout: header frame, then events.
 */
function writeLog(path: string, text: string, zstd: string): void {
  const temporary = `${path}.viztools-repair-tmp`
  if (path.endsWith('.zstd')) {
    const newline = text.indexOf('\n')
    const header = newline < 0 ? text : text.slice(0, newline + 1)
    const rest = newline < 0 ? '' : text.slice(newline + 1)
    const frame = (input: string): Buffer => execFileSync(zstd, ['-q', '-c', '-'], { input, maxBuffer: 1 << 30 })
    writeFileSync(temporary, rest === '' ? frame(header) : Buffer.concat([frame(header), frame(rest)]), { mode: 0o600 })
  } else {
    writeFileSync(temporary, text, { mode: 0o600 })
  }
  renameSync(temporary, path)
}

interface Exported { channel: StoreChannel; kind: string; data: { [key: string]: JsonValue }; logSeq: number }

/** Map one legacy event to the plugin store record that replaces it. */
export function legacyRecord(event: RawEvent): Exported | undefined {
  const type = String(event.type)
  const logSeq = Number(event.seq) + 1
  const origin = { migratedFrom: type, migratedSeq: Number(event.seq) }
  if (type === 'viztools-gate/change') {
    const change = decodeGateChange(event as never)
    if (change === undefined) return undefined
    if (change.kind === 'approved') return { channel: 'gate', kind: 'plan-approved', data: { planCallId: change.planCallId, ...origin }, logSeq }
    return { channel: 'gate', kind: 'refused', data: { callId: change.callId, tool: change.tool, code: 'PLAN_NOT_APPROVED', reason: change.reason, beforeApproval: true, ...origin }, logSeq }
  }
  if (type === 'viztools-run-rules/change') {
    const change = decodeRunRulesChange(event.data)
    if (change.kind === 'approved') return { channel: 'gate', kind: 'rules-approved', data: { callId: change.callId, rules: change.rules as unknown as JsonValue, ...origin }, logSeq }
    if (change.kind === 'started-call') return { channel: 'gate', kind: 'started', data: { callId: change.callId, tool: change.tool, ...origin }, logSeq }
    return {
      channel: 'gate', kind: 'refused', logSeq,
      data: { callId: change.callId, tool: change.tool, code: change.kind === 'limit-reached' ? 'RUN_RULE_LIMIT' : 'RUN_RULE_DENIED', reason: change.reason, beforeApproval: false, ...(change.count === undefined ? {} : { count: change.count }), ...(change.limit === undefined ? {} : { limit: change.limit }), ...origin },
    }
  }
  if (type === 'viztools-report/change') {
    const data = event.data as Record<string, JsonValue> | undefined
    if (data === undefined || (data.kind !== 'available' && data.kind !== 'failed')) return undefined
    const { kind, ...rest } = data
    return { channel: 'report', kind: String(kind), data: { ...rest, ...origin }, logSeq }
  }
  return undefined
}

function sessionIdOf(path: string, header: RawEvent | undefined): string {
  return typeof header?.id === 'string' ? header.id : basename(dirname(path))
}

export function repairSessions(options: RepairOptions): RepairedSession[] {
  const zstd = options.zstd ?? 'zstd'
  const now = options.now ?? Date.now
  const stateRoot = resolve(options.workspace, options.stateDir ?? '.dsh/viztools/state')
  const results: RepairedSession[] = []
  for (const log of findLogs(join(resolve(options.dshHome), 'sessions'))) {
    let sessionId = basename(dirname(log))
    try {
      const text = readLog(log, zstd)
      const lines = text.split('\n')
      const parsed: (RawEvent | undefined)[] = lines.map((line) => { if (line.trim() === '') return undefined; try { return JSON.parse(line) as RawEvent } catch { return undefined } })
      const header = parsed[0]?.type === 'session' ? parsed[0] : undefined
      sessionId = sessionIdOf(log, header)
      if (options.sessions !== undefined && !options.sessions.includes(sessionId)) continue
      const legacy = parsed.flatMap((event, index) => event !== undefined && LEGACY_EVENT_TYPES.has(String(event.type)) && event.ignorable !== true ? [index] : [])
      if (legacy.length === 0) { results.push({ sessionId, log, legacyEvents: 0, action: 'clean', exported: { gate: 0, report: 0 } }); continue }
      if (!isSafeSessionId(sessionId)) throw new Error(`unsafe session id ${sessionId}`)

      const records = legacy.map((index) => legacyRecord(parsed[index] as RawEvent)).filter((record): record is Exported => record !== undefined)
      const counts = { gate: records.filter((record) => record.channel === 'gate').length, report: records.filter((record) => record.channel === 'report').length }
      const existing = (['gate', 'report'] as const).filter((channel) => existsSync(join(stateRoot, `${sessionId}.${channel}.jsonl`)))
      const skipped = existing.length > 0 ? `sidecar already exists for ${existing.join(', ')}; not re-imported` : undefined
      if (options.dryRun) {
        results.push({ sessionId, log, legacyEvents: legacy.length, action: 'would-convert', exported: { ...counts, ...(skipped === undefined ? {} : { skipped }) } })
        continue
      }

      const stamp = now()
      const backup = `${log}.viztools-backup-${stamp}`
      copyFileSync(log, backup)
      // The projection cache is deliberately left in place: DSH lists sessions from it, it is
      // keyed by sequence numbers only, and this repair preserves every seq and changes no
      // event that a DSH projection reads. Moving it aside hides the session from the UI.

      if (skipped === undefined) {
        // Export with the original log positions so fork lineage cuts stay meaningful.
        const fake = { id: sessionId, seq: 0, header: {}, inheritedEventCount: 0, snapshotEvents: () => [] }
        const stores = { gate: createSidecarStore(stateRoot, fake, 'gate'), report: createSidecarStore(stateRoot, fake, 'report') }
        for (const record of records) { fake.seq = record.logSeq; stores[record.channel].append(record.kind, record.data) }
      }
      for (const index of legacy) {
        const event = parsed[index] as RawEvent
        lines[index] = JSON.stringify({ ...event, ignorable: true })
      }
      writeLog(log, lines.join('\n'), zstd)
      results.push({ sessionId, log, legacyEvents: legacy.length, action: 'converted', backup, exported: { ...counts, ...(skipped === undefined ? {} : { skipped }) } })
    } catch (error) {
      results.push({ sessionId, log, legacyEvents: 0, action: 'failed', exported: { gate: 0, report: 0 }, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return results
}
