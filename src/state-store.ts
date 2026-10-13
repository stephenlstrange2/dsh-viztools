import { createHash } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import * as dshSession from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { isSafeSessionId } from './managed-state.js'

/**
 * Durable plugin-owned state, kept OUT of the DSH session log on DSH 0.2.0-rc.2.
 *
 * rc.2 persistence refuses to load a session log that contains an unknown event type
 * without the `ignorable` envelope marker, and rc.2 gives plugins no way to set it.
 * Writing `viztools-*` events into the log therefore made every touched session
 * unopenable after a restart. This module stores the same records either in:
 *
 * - a **sidecar** log per session and channel (rc.2): append-only JSONL, one fsync per
 *   record, a per-record index plus SHA-256 hash chain so truncation/tampering is
 *   detectable, and fork lineage through the session header; or
 * - DSH **plugin records** (`appendPluginRecord`, DSH ≥ 0.2.1) when the runtime offers
 *   them: ignorable `plugin:dsh-viztools/<channel>` events that fork/resume carry.
 *
 * Readers get an integrity verdict so policy can fail closed.
 */

export type StoreChannel = 'gate' | 'report'
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

export interface StoredRecord {
  /** Index within this session's chain (0-based, contiguous). */
  readonly i: number
  /** Hash of the previous record line ('' for the first record or a reset). */
  readonly prev: string
  readonly t: number
  /** Session log length when the record was written; used to cut fork lineage. */
  readonly logSeq: number
  readonly kind: string
  readonly data: { readonly [key: string]: JsonValue }
  /** Session that wrote the record (differs from the reader for inherited records). */
  readonly session: string
}

export type StoreIntegrity =
  | { readonly status: 'ok' }
  | { readonly status: 'missing' | 'truncated'; readonly reason: string }

export interface StoreSnapshot {
  /** Valid records in order: inherited (fork lineage) first, then this session's own. */
  readonly records: readonly StoredRecord[]
  readonly integrity: StoreIntegrity
  /** Damage was followed by a reset record, so post-reset records are authoritative. */
  readonly resynced: boolean
  /** Whether the store has ever been written for this session (own records exist). */
  readonly exists: boolean
}

export interface StateStore {
  readonly backend: 'sidecar' | 'plugin-record'
  readonly location: string
  read(): StoreSnapshot
  /** Durably append one record. Throws when the write cannot be made durable. */
  append(kind: string, data: { readonly [key: string]: JsonValue }): StoredRecord
}

/** Minimal Session surface the store needs; matches `@deepseek-ai/dsh-session` Session. */
export interface StoreSession {
  readonly id: unknown
  readonly seq: unknown
  readonly header: { readonly parentSession?: unknown; readonly isSeeded?: boolean }
  readonly inheritedEventCount: unknown
  snapshotEvents(): readonly SessionEvent[]
}

export interface PluginRecordApi {
  appendPluginRecord(session: unknown, type: string, data: unknown): unknown
  pluginRecordOf(event: SessionEvent): { readonly type: string; readonly data: unknown } | undefined
}

/** The plugin-record API of the running DSH, when it has one (DSH ≥ 0.2.1). */
export function detectPluginRecordApi(module: unknown = dshSession): PluginRecordApi | undefined {
  const candidate = module as Partial<PluginRecordApi>
  return typeof candidate.appendPluginRecord === 'function' && typeof candidate.pluginRecordOf === 'function'
    ? { appendPluginRecord: candidate.appendPluginRecord, pluginRecordOf: candidate.pluginRecordOf }
    : undefined
}

export function pluginRecordType(channel: StoreChannel): string {
  return `plugin:dsh-viztools/${channel}`
}

function lineHash(line: string): string {
  return createHash('sha256').update(line).digest('hex').slice(0, 32)
}

function serialize(record: StoredRecord): string {
  return JSON.stringify(record)
}

interface ChainResult {
  readonly records: StoredRecord[]
  readonly integrity: StoreIntegrity
  readonly next: { readonly i: number; readonly prev: string }
  /** Whether the next append must be a reset (corruption seen) or start on a fresh line. */
  readonly needsReset: boolean
  readonly tornTail: boolean
  /** A reset record restarted the chain after the damage. */
  readonly resynced: boolean
}

function decodeRecord(value: unknown): StoredRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (!Number.isSafeInteger(record.i) || typeof record.prev !== 'string' || typeof record.kind !== 'string' || !Number.isSafeInteger(record.logSeq)) return undefined
  if (typeof record.data !== 'object' || record.data === null || Array.isArray(record.data) || typeof record.session !== 'string') return undefined
  return record as unknown as StoredRecord
}

/**
 * Verify a chain of serialized records. A broken link marks the store truncated; records
 * after the break are ignored until a `reset` record (prev '') restarts the chain, so a
 * damaged session never silently regains trust but can still record new evidence.
 */
export function verifyChain(lines: readonly string[], tornTail = false): ChainResult {
  const records: StoredRecord[] = []
  let expected = 0
  let prev = ''
  let broken: string | undefined = tornTail ? 'the last record was only partially written' : undefined
  let synced = true
  let resynced = false
  for (const [position, line] of lines.entries()) {
    let record: StoredRecord | undefined
    try { record = decodeRecord(JSON.parse(line)) } catch { record = undefined }
    if (!synced) {
      if (record?.kind === 'reset' && record.prev === '') { synced = true; resynced = true; records.push(record); expected = record.i + 1; prev = lineHash(line) }
      continue
    }
    if (record === undefined || record.i !== expected || record.prev !== prev) {
      if (record?.kind === 'reset' && record.prev === '' && position > 0 && broken !== undefined) { resynced = true; records.push(record); expected = record.i + 1; prev = lineHash(line); continue }
      broken ??= record === undefined ? `record ${position} is unreadable` : `record ${position} breaks the hash chain`
      synced = false
      continue
    }
    records.push(record)
    expected = record.i + 1
    prev = lineHash(line)
  }
  return {
    records,
    integrity: broken === undefined ? { status: 'ok' } : { status: 'truncated', reason: broken },
    next: { i: expected, prev },
    needsReset: broken !== undefined && !(resynced && synced),
    tornTail: tornTail && !resynced,
    resynced,
  }
}

function sidecarPath(root: string, sessionId: string, channel: StoreChannel): string {
  if (!isSafeSessionId(sessionId)) throw new Error(`invalid session id for plugin state: ${sessionId}`)
  return join(root, `${sessionId}.${channel}.jsonl`)
}

function readSidecar(path: string): { lines: string[]; tornTail: boolean; exists: boolean } {
  if (!existsSync(path)) return { lines: [], tornTail: false, exists: false }
  const text = readFileSync(path, 'utf8')
  const tornTail = text.length > 0 && !text.endsWith('\n')
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return { lines, tornTail, exists: true }
}

function worst(a: StoreIntegrity, b: StoreIntegrity): StoreIntegrity {
  if (a.status !== 'ok') return a
  return b
}

/** Sidecar store: `<root>/<session>.<channel>.jsonl`, append + fsync per record. */
export function createSidecarStore(rootDir: string, session: StoreSession, channel: StoreChannel): StateStore {
  const root = resolve(rootDir)
  const sessionId = String(session.id)
  const path = sidecarPath(root, sessionId, channel)
  let cursor: { i: number; prev: string; needsReset: boolean; tornTail: boolean } | undefined

  function lineage(): { records: StoredRecord[]; integrity: StoreIntegrity } {
    const parent = session.header.parentSession
    if (parent === undefined || session.header.isSeeded !== true) return { records: [], integrity: { status: 'ok' } }
    const cut = Number(session.inheritedEventCount)
    const parentId = String(parent)
    if (!isSafeSessionId(parentId)) return { records: [], integrity: { status: 'truncated', reason: 'fork parent id is not a safe session id' } }
    const parentPath = sidecarPath(root, parentId, channel)
    const raw = readSidecar(parentPath)
    if (!raw.exists) return { records: [], integrity: { status: 'ok' } }
    const chain = verifyChain(raw.lines, raw.tornTail)
    return { records: chain.records.filter((record) => record.logSeq <= cut), integrity: chain.integrity }
  }

  return {
    backend: 'sidecar',
    location: path,
    read() {
      const inherited = lineage()
      const raw = readSidecar(path)
      const chain = verifyChain(raw.lines, raw.tornTail)
      cursor = { i: chain.next.i, prev: chain.next.prev, needsReset: chain.needsReset, tornTail: chain.tornTail }
      return { records: [...inherited.records, ...chain.records], integrity: worst(inherited.integrity, chain.integrity), resynced: chain.resynced, exists: raw.exists && raw.lines.length > 0 }
    },
    append(kind, data) {
      if (cursor === undefined) this.read()
      const state = cursor as { i: number; prev: string; needsReset: boolean; tornTail: boolean }
      let prefix = ''
      if (state.needsReset) {
        // Restart the chain after damage so new evidence is verifiable; trust is not restored.
        const reset: StoredRecord = { i: state.i, prev: '', t: Date.now(), logSeq: Number(session.seq), kind: 'reset', data: { reason: 'prior plugin state was damaged' }, session: sessionId }
        prefix = `${state.tornTail ? '\n' : ''}${serialize(reset)}\n`
        state.i += 1
        state.prev = lineHash(serialize(reset))
        state.needsReset = false
        state.tornTail = false
      }
      const record: StoredRecord = { i: state.i, prev: state.prev, t: Date.now(), logSeq: Number(session.seq), kind, data, session: sessionId }
      const line = serialize(record)
      const created = !existsSync(path)
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      const fd = openSync(path, 'a', 0o600)
      try {
        writeSync(fd, `${prefix}${line}\n`)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      if (created) {
        // Make the new directory entry durable too.
        try { const dir = openSync(dirname(path), 'r'); try { fsyncSync(dir) } finally { closeSync(dir) } } catch { /* best effort on platforms without directory fsync */ }
      }
      state.i += 1
      state.prev = lineHash(line)
      return record
    },
  }
}

/** Plugin-record store: ignorable `plugin:dsh-viztools/<channel>` events in the session log. */
export function createPluginRecordStore(session: StoreSession, channel: StoreChannel, api: PluginRecordApi): StateStore {
  const type = pluginRecordType(channel)
  const sessionId = String(session.id)
  const lines = (): string[] => {
    const out: string[] = []
    for (const event of session.snapshotEvents()) {
      const record = api.pluginRecordOf(event)
      if (record?.type === type) out.push(JSON.stringify(record.data))
    }
    return out
  }
  let cursor: { i: number; prev: string; needsReset: boolean } | undefined
  return {
    backend: 'plugin-record',
    location: `${sessionId}#${type}`,
    read() {
      const all = lines()
      const chain = verifyChain(all)
      cursor = { i: chain.next.i, prev: chain.next.prev, needsReset: chain.needsReset }
      return { records: chain.records, integrity: chain.integrity, resynced: chain.resynced, exists: all.length > 0 }
    },
    append(kind, data) {
      if (cursor === undefined) this.read()
      const state = cursor as { i: number; prev: string; needsReset: boolean }
      if (state.needsReset) {
        const reset: StoredRecord = { i: state.i, prev: '', t: Date.now(), logSeq: Number(session.seq), kind: 'reset', data: { reason: 'prior plugin state was damaged' }, session: sessionId }
        api.appendPluginRecord(session, type, reset)
        state.i += 1
        state.prev = lineHash(serialize(reset))
        state.needsReset = false
      }
      const record: StoredRecord = { i: state.i, prev: state.prev, t: Date.now(), logSeq: Number(session.seq), kind, data, session: sessionId }
      api.appendPluginRecord(session, type, record)
      state.i += 1
      state.prev = lineHash(serialize(record))
      return record
    },
  }
}

export interface OpenStoreOptions {
  readonly root: string
  readonly session: StoreSession
  readonly channel: StoreChannel
  /** Override detection (tests). `null` forces the sidecar. */
  readonly pluginRecords?: PluginRecordApi | null
}

/** Plugin records when DSH supports them, otherwise the rc.2 sidecar. */
export function openStateStore(options: OpenStoreOptions): StateStore {
  const api = options.pluginRecords === null ? undefined : options.pluginRecords ?? detectPluginRecordApi()
  return api === undefined ? createSidecarStore(options.root, options.session, options.channel) : createPluginRecordStore(options.session, options.channel, api)
}
