import { execFileSync, spawn } from 'node:child_process'
import { closeSync, constants, copyFileSync, existsSync, fsyncSync, openSync, readdirSync, readFileSync, renameSync, writeSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'
import { decodeGateChange } from './gate-domain.js'
import { isSafeSessionId } from './managed-state.js'
import { decodeRunRulesChange } from './run-rules.js'
import { createSidecarStore, loadKeyring, type JsonValue, type Keyring, type StoreChannel } from './state-store.js'

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
  /** Key directory for the sidecar HMAC chain and anchors (default `<dshHome>/viztools`). */
  readonly keyDir?: string
  /** Acquire DSH's session write lease; injectable for tests. */
  readonly lease?: (sessionDir: string) => Promise<SessionLease>
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
  /** Legacy events inside a fork's inherited prefix: marked ignorable but not re-exported. */
  readonly inherited?: number
}

export interface SessionLease {
  release(): Promise<void>
}

export class SessionLeaseHeldError extends Error {
  constructor(dir: string) {
    super(`DSH holds the session lease (${join(dir, 'session.lock')}); stop every DSH process using this home before repairing`)
  }
}

function fsyncPath(path: string): void {
  try { const fd = openSync(path, 'r'); try { fsyncSync(fd) } finally { closeSync(fd) } } catch { /* directories cannot be fsync'd everywhere */ }
}

/**
 * Take the same kernel lease DSH uses: a non-blocking exclusive flock(2) on
 * `<session>/session.lock`, held for the whole repair. DSH's own native addon is used when it
 * is resolvable; otherwise the util-linux `flock` command holds the lock in a child process.
 * When the lease is held by DSH, or cannot be taken at all, the session is refused.
 */
export async function acquireSessionLease(sessionDir: string, flockCommand = 'flock'): Promise<SessionLease> {
  const lockPath = join(sessionDir, 'session.lock')
  try {
    const addon = await import('@deepseek-ai/node-addon-system/flock' as string) as { tryLockExclusive?: (fd: number) => Promise<void> }
    if (typeof addon.tryLockExclusive === 'function') {
      const fd = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT, 0o600)
      try {
        await addon.tryLockExclusive(fd)
      } catch (error) {
        closeSync(fd)
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'EAGAIN' || code === 'EWOULDBLOCK') throw new SessionLeaseHeldError(sessionDir)
        throw error
      }
      return { release: async () => { closeSync(fd) } }
    }
  } catch (error) {
    if (error instanceof SessionLeaseHeldError) throw error
    /* addon not resolvable from this install: use the flock command */
  }
  return await new Promise<SessionLease>((resolvePromise, reject) => {
    const child = spawn(flockCommand, ['--nonblock', '--conflict-exit-code', '75', lockPath, '-c', 'printf LOCKED; exec cat >/dev/null'], { stdio: ['pipe', 'pipe', 'ignore'] })
    let settled = false
    child.once('error', (error) => { if (!settled) { settled = true; reject(new Error(`cannot take the DSH session lease without flock(2) support: ${error.message}`)) } })
    child.once('exit', (code) => { if (!settled) { settled = true; reject(code === 75 ? new SessionLeaseHeldError(sessionDir) : new Error(`flock exited ${code} while taking the session lease`)) } })
    child.stdout.once('data', () => {
      if (settled) return
      settled = true
      resolvePromise({
        release: async () => {
          if (child.exitCode !== null) return
          await new Promise<void>((done) => { child.once('exit', () => done()); child.stdin.end() })
        },
      })
    })
  })
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
  let contents: Buffer
  if (path.endsWith('.zstd')) {
    const newline = text.indexOf('\n')
    const header = newline < 0 ? text : text.slice(0, newline + 1)
    const rest = newline < 0 ? '' : text.slice(newline + 1)
    const frame = (input: string): Buffer => execFileSync(zstd, ['-q', '-c', '-'], { input, maxBuffer: 1 << 30 })
    contents = rest === '' ? frame(header) : Buffer.concat([frame(header), frame(rest)])
  } else {
    contents = Buffer.from(text, 'utf8')
  }
  // Unique, exclusively created temp file (never follows a planted name), fsync'd before the
  // rename, then the directory entry is fsync'd too.
  const temporary = `${path}.viztools-repair-${process.pid}-${randomBytes(8).toString('hex')}`
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  try {
    writeSync(fd, contents)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temporary, path)
  fsyncPath(dirname(path))
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

export async function repairSessions(options: RepairOptions): Promise<RepairedSession[]> {
  const zstd = options.zstd ?? 'zstd'
  const now = options.now ?? Date.now
  const stateRoot = resolve(options.workspace, options.stateDir ?? '.dsh/viztools/state')
  const lease = options.lease ?? ((dir: string) => acquireSessionLease(dir))
  let keyring: Keyring | undefined
  const results: RepairedSession[] = []
  for (const log of findLogs(join(resolve(options.dshHome), 'sessions'))) {
    let sessionId = basename(dirname(log))
    let held: SessionLease | undefined
    try {
      const preview = readLog(log, zstd)
      const previewHeader = (() => { try { return JSON.parse(preview.slice(0, preview.indexOf('\n'))) as RawEvent } catch { return undefined } })()
      sessionId = sessionIdOf(log, previewHeader?.type === 'session' ? previewHeader : undefined)
      if (options.sessions !== undefined && !options.sessions.includes(sessionId)) continue
      if (!options.dryRun) held = await lease(dirname(log))
      // Re-read under the lease: DSH may have appended before it stopped.
      const text = options.dryRun ? preview : readLog(log, zstd)
      const lines = text.split('\n')
      const parsed: (RawEvent | undefined)[] = lines.map((line) => { if (line.trim() === '') return undefined; try { return JSON.parse(line) as RawEvent } catch { return undefined } })
      const header = parsed[0]?.type === 'session' ? parsed[0] : undefined
      const legacy = parsed.flatMap((event, index) => event !== undefined && LEGACY_EVENT_TYPES.has(String(event.type)) && event.ignorable !== true ? [index] : [])
      if (legacy.length === 0) { results.push({ sessionId, log, legacyEvents: 0, action: 'clean', exported: { gate: 0, report: 0 } }); continue }
      if (!isSafeSessionId(sessionId)) throw new Error(`unsafe session id ${sessionId}`)

      // A fork's log repeats its parent's events up to the last `session/end-seed {inherited}`.
      // Those legacy events belong to the parent's sidecar (inherited through lineage), so they
      // are marked ignorable here but never exported again into the child.
      const parent = header?.isSeeded === true && typeof header.parentSession === 'string' ? header.parentSession : undefined
      const cutSeq = parent === undefined ? 0 : Math.max(0, ...parsed.filter((event) => event?.type === 'session/end-seed' && (event.data as { inherited?: unknown } | undefined)?.inherited === true).map((event) => Number(event?.seq)))
      const own = legacy.filter((index) => Number((parsed[index] as RawEvent).seq) >= cutSeq)
      const inherited = legacy.length - own.length
      const records = own.map((index) => legacyRecord(parsed[index] as RawEvent)).filter((record): record is Exported => record !== undefined)
      const counts = { gate: records.filter((record) => record.channel === 'gate').length, report: records.filter((record) => record.channel === 'report').length }
      const existing = (['gate', 'report'] as const).filter((channel) => existsSync(join(stateRoot, `${sessionId}.${channel}.jsonl`)))
      const skipped = existing.length > 0 ? `sidecar already exists for ${existing.join(', ')}; not re-imported` : undefined
      const extra = { ...(inherited > 0 ? { inherited } : {}) }
      if (options.dryRun) {
        results.push({ sessionId, log, legacyEvents: legacy.length, action: 'would-convert', exported: { ...counts, ...(skipped === undefined ? {} : { skipped }) }, ...extra })
        continue
      }

      const backup = `${log}.viztools-backup-${now()}-${randomBytes(4).toString('hex')}`
      copyFileSync(log, backup, constants.COPYFILE_EXCL)
      fsyncPath(backup)
      // The projection cache is deliberately left in place: DSH lists sessions from it, it is
      // keyed by sequence numbers only, and this repair preserves every seq and changes no
      // event that a DSH projection reads. Moving it aside hides the session from the UI.

      if (skipped === undefined && (records.length > 0 || parent !== undefined)) {
        keyring ??= loadKeyring(options.keyDir ?? join(resolve(options.dshHome), 'viztools'))
        // Export with the original log positions and the fork lineage, keyed and anchored.
        const fake = { id: sessionId, seq: 0, header: parent === undefined ? {} : { isSeeded: true, parentSession: parent }, inheritedEventCount: cutSeq, snapshotEvents: () => [] }
        const stores = { gate: createSidecarStore(stateRoot, fake, 'gate', keyring), report: createSidecarStore(stateRoot, fake, 'report', keyring) }
        if (parent !== undefined) { stores.gate.read(); stores.report.read() }
        for (const record of records) { fake.seq = record.logSeq; stores[record.channel].append(record.kind, record.data) }
      }
      for (const index of legacy) {
        const event = parsed[index] as RawEvent
        lines[index] = JSON.stringify({ ...event, ignorable: true })
      }
      writeLog(log, lines.join('\n'), zstd)
      results.push({ sessionId, log, legacyEvents: legacy.length, action: 'converted', backup, exported: { ...counts, ...(skipped === undefined ? {} : { skipped }) }, ...extra })
    } catch (error) {
      results.push({ sessionId, log, legacyEvents: 0, action: 'failed', exported: { gate: 0, report: 0 }, error: error instanceof Error ? error.message : String(error) })
    } finally {
      await held?.release()
    }
  }
  return results
}
