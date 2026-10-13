import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import * as dshSession from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { isSafeSessionId } from './managed-state.js'

/**
 * Durable plugin-owned state, kept OUT of the DSH session log on DSH 0.2.0-rc.2.
 *
 * rc.2 persistence refuses to load a session log that contains an unknown event type
 * without the `ignorable` envelope marker, and rc.2 gives plugins no way to set it, so the
 * records live either in:
 *
 * - a **sidecar** log per session and channel (rc.2): append-only JSONL under the workspace,
 *   one fsync per record; or
 * - DSH **plugin records** (`appendPluginRecord`, DSH ≥ 0.2.1): ignorable
 *   `plugin:dsh-viztools/<channel>` events in the session log.
 *
 * Integrity does not rely on the workspace: every record carries an HMAC-SHA256 chained to
 * the previous record's MAC, with a key stored OUTSIDE the workspace (default
 * `$DSH_HOME/viztools/sidecar.key`). A MAC'd **anchor** with the last record index, its MAC,
 * and fork lineage lives next to the key. A process that can write the workspace but not
 * the DSH home cannot forge records (no key) nor truncate the tail (the anchor names the
 * head). Readers get an integrity verdict so policy can fail closed.
 */

export type StoreChannel = 'gate' | 'report'
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

export interface StoredRecord {
  /** Index within this session's chain (0-based, contiguous; a reset continues the count). */
  readonly i: number
  /** MAC of the previous record ('' for the first record or a reset). */
  readonly prev: string
  readonly t: number
  /** Session log length when the record was written; used to cut fork lineage. */
  readonly logSeq: number
  readonly kind: string
  readonly data: { readonly [key: string]: JsonValue }
  /** Session that wrote the record (differs from the reader for inherited records). */
  readonly session: string
  /** HMAC-SHA256 over the record's canonical fields and the chain link. */
  readonly mac: string
}

export type StoreIntegrity =
  | { readonly status: 'ok' }
  | { readonly status: 'missing' | 'truncated'; readonly reason: string }

export interface StoreSnapshot {
  /** Valid records in order: inherited (fork lineage, recursively) first, then this session's own. */
  readonly records: readonly StoredRecord[]
  readonly integrity: StoreIntegrity
  /** Damage was followed by a reset record, so post-reset records are authoritative. */
  readonly resynced: boolean
  /** Whether state exists for this session: own records, an anchor, or inherited records. */
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

/** HMAC key plus the out-of-workspace directory that holds anchors. */
export interface Keyring {
  readonly dir: string
  readonly key: Buffer
}

/** Default key directory: `$DSH_HOME/viztools` (DSH home defaults to `~/.dsh`). */
export function defaultKeyDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.DSH_HOME !== undefined && env.DSH_HOME !== '' ? env.DSH_HOME : join(homedir(), '.dsh'), 'viztools')
}

/** Resolve symlinks of the longest existing prefix, so not-yet-created paths compare by realpath too. */
export function realPathish(path: string): string {
  let current = resolve(path)
  const rest: string[] = []
  for (;;) {
    try {
      return join(realpathSync(current), ...rest.reverse())
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(current)
      if (parent === current) return resolve(path)
      rest.push(basename(current))
      current = parent
    }
  }
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

/** Refuse a key directory inside the workspace (compared by realpath): the key must not be writable from there. */
export function assertKeyDirOutside(keyDir: string, workspace: string): void {
  const key = realPathish(keyDir)
  const work = realPathish(workspace)
  if (inside(work, key)) throw new Error(`dsh-viztools keyDir must be outside the workspace (${work}); got ${key}`)
}

function fsyncDir(dir: string): void {
  try { const fd = openSync(dir, 'r'); try { fsyncSync(fd) } finally { closeSync(fd) } } catch { /* best effort where directories cannot be fsync'd */ }
}

/** Write a file atomically: unique temp name, fsync, rename, fsync the directory. */
export function writeFileAtomicSync(path: string, contents: string | Buffer, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
  const fd = openSync(temporary, 'wx', mode)
  try {
    if (typeof contents === 'string') writeSync(fd, contents)
    else writeSync(fd, contents)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temporary, path)
  fsyncDir(dirname(path))
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Owner-only check: no group/other permission bits, owned by this user, not a symlink. */
export function assertPrivate(path: string, kind: 'directory' | 'file'): void {
  const info = lstatSync(path)
  if (info.isSymbolicLink()) throw new Error(`dsh-viztools ${kind} ${path} must not be a symbolic link`)
  if (kind === 'directory' ? !info.isDirectory() : !info.isFile()) throw new Error(`dsh-viztools ${kind} ${path} is not a ${kind}`)
  if (process.platform === 'win32') return
  if ((info.mode & 0o077) !== 0) throw new Error(`dsh-viztools ${kind} ${path} must not be accessible to group or others (mode ${(info.mode & 0o777).toString(8)})`)
  const uid = process.getuid?.()
  if (uid !== undefined && info.uid !== uid) throw new Error(`dsh-viztools ${kind} ${path} is owned by uid ${info.uid}, not ${uid}`)
}

const KEY_HEX_LENGTH = 64

/**
 * Load (or create once) the HMAC key in `keyDir`. Creation is race-safe: the key is written
 * and fsync'd to a unique temp file, then hard-linked into place (the link fails if another
 * process won), so the key file is never observed partially written. Readers still retry
 * briefly on an empty or short file, which older writers could leave behind. The directory
 * and the file must be owner-only.
 */
export function loadKeyring(keyDir: string = defaultKeyDir()): Keyring {
  const dir = realPathish(keyDir)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  assertPrivate(dir, 'directory')
  const path = join(dir, 'sidecar.key')
  if (!existsSync(path)) {
    const temporary = join(dir, `.sidecar.key.${process.pid}.${randomBytes(6).toString('hex')}`)
    const fd = openSync(temporary, 'wx', 0o600)
    try { writeSync(fd, randomBytes(32).toString('hex')); fsyncSync(fd) } finally { closeSync(fd) }
    try {
      linkSync(temporary, path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    } finally {
      unlinkSync(temporary)
    }
    fsyncDir(dir)
  }
  let text = ''
  for (let attempt = 0; attempt < 50; attempt++) {
    text = readFileSync(path, 'utf8').trim()
    if (text.length >= KEY_HEX_LENGTH) break
    sleepSync(20)
  }
  assertPrivate(path, 'file')
  const key = Buffer.from(text, 'hex')
  if (text.length < KEY_HEX_LENGTH || key.length < 32) throw new Error(`dsh-viztools key at ${path} is empty or invalid`)
  return { dir, key }
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

function hmac(key: Buffer, value: unknown): string {
  return createHmac('sha256', key).update(JSON.stringify(value)).digest('hex')
}

function same(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

/**
 * MAC input binds the record to its session AND channel. Verification recomputes it with the
 * READER's expected session id, never the id the record claims, so a record copied from
 * another session's (or channel's) sidecar fails authentication.
 */
function recordMac(key: Buffer, channel: StoreChannel, session: string, record: Omit<StoredRecord, 'mac'>): string {
  return hmac(key, { v: 1, channel, session, i: record.i, prev: record.prev, t: record.t, logSeq: record.logSeq, kind: record.kind, data: record.data })
}

function sign(key: Buffer, channel: StoreChannel, record: Omit<StoredRecord, 'mac'>): StoredRecord {
  return { ...record, mac: recordMac(key, channel, record.session, record) }
}

interface ChainResult {
  readonly records: StoredRecord[]
  readonly integrity: StoreIntegrity
  readonly next: { readonly i: number; readonly prev: string }
  /** Whether the next append must be a reset (corruption seen). */
  readonly needsReset: boolean
  readonly tornTail: boolean
  /** A reset record restarted the chain after the damage. */
  readonly resynced: boolean
}

function decodeRecord(value: unknown): StoredRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (!Number.isSafeInteger(record.i) || typeof record.prev !== 'string' || typeof record.kind !== 'string' || !Number.isSafeInteger(record.logSeq) || !Number.isSafeInteger(record.t)) return undefined
  if (typeof record.data !== 'object' || record.data === null || Array.isArray(record.data) || typeof record.session !== 'string' || typeof record.mac !== 'string') return undefined
  return record as unknown as StoredRecord
}

/**
 * Verify a chain of serialized records with the key. A forged, edited, reordered, or
 * missing record breaks the chain and marks the store truncated; records after the break are
 * ignored until a MAC-valid `reset` record (prev '') restarts it, so a damaged session never
 * silently regains trust but can still record new evidence.
 */
/**
 * @param expectedSession - the session whose chain this is; a record claiming another session
 *   (or a function deciding per record, for in-log plugin records that span a fork) is rejected.
 */
export function verifyChain(lines: readonly string[], keyring: Keyring, channel: StoreChannel, expectedSession: string | ((record: StoredRecord) => string | undefined), tornTail = false): ChainResult {
  // A torn final line is a write the crash interrupted. Records are anchored only after they
  // are durable, so it never held anchored state; the anchor check catches real truncation.
  const complete = tornTail ? lines.slice(0, -1) : lines
  const records: StoredRecord[] = []
  let expected = 0
  let prev = ''
  let broken: string | undefined
  let synced = true
  let resynced = false
  for (const [position, line] of complete.entries()) {
    let record: StoredRecord | undefined
    try { record = decodeRecord(JSON.parse(line)) } catch { record = undefined }
    const owner = record === undefined ? undefined : typeof expectedSession === 'string' ? expectedSession : expectedSession(record)
    const authentic = record !== undefined && owner !== undefined && record.session === owner && same(record.mac, recordMac(keyring.key, channel, owner, record))
    if (record !== undefined && authentic && record.kind === 'reset' && record.prev === '') {
      // Our own marker that earlier damage was detected: restart the chain here and keep the
      // store flagged as damaged, so trust in pre-reset counts is never restored.
      broken ??= 'a reset record marks earlier damage'
      synced = true
      resynced = true
      records.push(record)
      expected = record.i + 1
      prev = record.mac
      continue
    }
    if (!synced) continue
    if (record === undefined || !authentic || record.i !== expected || record.prev !== prev) {
      broken ??= record === undefined ? `record ${position} is unreadable` : !authentic ? `record ${position} fails authentication` : `record ${position} breaks the chain`
      synced = false
      continue
    }
    records.push(record)
    expected = record.i + 1
    prev = record.mac
  }
  return {
    records,
    integrity: broken === undefined ? { status: 'ok' } : { status: 'truncated', reason: broken },
    next: { i: expected, prev },
    needsReset: broken !== undefined && !(resynced && synced),
    tornTail,
    resynced,
  }
}

/** Out-of-workspace anchor: last record index and MAC, plus fork lineage. */
export interface Anchor {
  readonly session: string
  readonly channel: StoreChannel
  /** Index of the last record written (-1 before the first). */
  readonly last: number
  readonly head: string
  readonly parent?: string
  readonly cut?: number
}

function anchorPath(keyring: Keyring, sessionId: string, channel: StoreChannel): string {
  return join(keyring.dir, 'anchors', `${sessionId}.${channel}.json`)
}

function anchorMac(key: Buffer, anchor: Anchor): string {
  return hmac(key, { v: 1, session: anchor.session, channel: anchor.channel, last: anchor.last, head: anchor.head, parent: anchor.parent ?? null, cut: anchor.cut ?? null })
}

export function readAnchor(keyring: Keyring, sessionId: string, channel: StoreChannel): Anchor | 'invalid' | undefined {
  const path = anchorPath(keyring, sessionId, channel)
  if (!existsSync(path)) return undefined
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Anchor & { mac?: unknown }
    if (value.session !== sessionId || value.channel !== channel || typeof value.mac !== 'string' || !Number.isSafeInteger(value.last) || typeof value.head !== 'string') return 'invalid'
    const { mac, ...anchor } = value
    return same(mac, anchorMac(keyring.key, anchor)) ? anchor : 'invalid'
  } catch {
    return 'invalid'
  }
}

export function writeAnchor(keyring: Keyring, anchor: Anchor): void {
  writeFileAtomicSync(anchorPath(keyring, anchor.session, anchor.channel), JSON.stringify({ ...anchor, mac: anchorMac(keyring.key, anchor) }))
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

/**
 * Check the verified chain against its anchor. This runs even when the chain itself is
 * damaged (after a reset): the anchored head must be present, so truncating post-reset
 * records (for example a later, narrowing rules approval) is detected. At most ONE MAC-valid
 * record may lie beyond the anchor (a crash between the record and the anchor write).
 */
function anchored(chain: ChainResult, anchor: Anchor | 'invalid' | undefined, hasRecords: boolean): StoreIntegrity {
  if (anchor === 'invalid') return { status: 'truncated', reason: 'the out-of-workspace anchor fails authentication' }
  if (anchor === undefined) return hasRecords ? { status: 'truncated', reason: 'records exist but their out-of-workspace anchor is missing' } : { status: 'ok' }
  const beyond = chain.records.filter((record) => record.i > anchor.last).length
  if (beyond > 1) return { status: 'truncated', reason: `${beyond} records lie beyond the out-of-workspace anchor (at most one is possible)` }
  if (anchor.last < 0) return { status: 'ok' }
  const head = chain.records.find((record) => record.i === anchor.last)
  if (head === undefined) return hasRecords ? { status: 'truncated', reason: `records up to #${anchor.last} were written but are missing` } : { status: 'missing', reason: 'the sidecar is missing although its anchor records written state' }
  if (!same(head.mac, anchor.head)) return { status: 'truncated', reason: `record #${anchor.last} does not match its anchor` }
  return { status: 'ok' }
}

function worst(a: StoreIntegrity, b: StoreIntegrity): StoreIntegrity {
  return a.status !== 'ok' ? a : b
}

const MAX_LINEAGE = 32

interface SidecarRead { records: StoredRecord[]; integrity: StoreIntegrity; exists: boolean; anchorOk: boolean }

/** Read one session's verified sidecar, recursively including its fork ancestors up to `cut`. */
function readLineage(root: string, keyring: Keyring, channel: StoreChannel, sessionId: string, cut: number | undefined, header: { parent?: string; cut?: number } | undefined, seen: Set<string>): SidecarRead {
  if (seen.has(sessionId) || seen.size >= MAX_LINEAGE) return { records: [], integrity: { status: 'truncated', reason: 'fork lineage is cyclic or too deep' }, exists: true, anchorOk: false }
  seen.add(sessionId)
  const anchor = readAnchor(keyring, sessionId, channel)
  const lineage = header ?? (anchor !== undefined && anchor !== 'invalid' && anchor.parent !== undefined ? { parent: anchor.parent, ...(anchor.cut === undefined ? {} : { cut: anchor.cut }) } : undefined)
  let inherited: SidecarRead = { records: [], integrity: { status: 'ok' }, exists: false, anchorOk: true }
  if (lineage?.parent !== undefined) {
    inherited = isSafeSessionId(lineage.parent)
      ? readLineage(root, keyring, channel, lineage.parent, lineage.cut, undefined, seen)
      : { records: [], integrity: { status: 'truncated', reason: 'fork parent id is not a safe session id' }, exists: true, anchorOk: false }
  }
  const raw = readSidecar(sidecarPath(root, sessionId, channel))
  const chain = verifyChain(raw.lines, keyring, channel, sessionId, raw.tornTail)
  const anchorIntegrity = anchored(chain, anchor, chain.records.length > 0 || raw.lines.length > 0)
  const integrity = worst(inherited.integrity, worst(chain.integrity, anchorIntegrity))
  const own = chain.records
  const all = [...inherited.records, ...own]
  return {
    records: cut === undefined ? all : all.filter((record) => record.logSeq <= cut),
    integrity,
    exists: inherited.exists || raw.lines.length > 0 || (anchor !== undefined && anchor !== 'invalid' && anchor.last >= 0),
    anchorOk: inherited.anchorOk && anchorIntegrity.status === 'ok',
  }
}

/** Sidecar store: `<root>/<session>.<channel>.jsonl`, append + fsync per record, keyed chain + anchor. */
export function createSidecarStore(rootDir: string, session: StoreSession, channel: StoreChannel, keyring: Keyring = loadKeyring()): StateStore {
  const root = resolve(rootDir)
  const sessionId = String(session.id)
  const path = sidecarPath(root, sessionId, channel)
  const parent = session.header.isSeeded === true && session.header.parentSession !== undefined ? String(session.header.parentSession) : undefined
  const cut = parent === undefined ? undefined : Number(session.inheritedEventCount)
  let cursor: { i: number; prev: string; needsReset: boolean; tornTail: boolean } | undefined

  function lineageHeader(): Pick<Anchor, 'parent' | 'cut'> {
    return parent === undefined ? {} : { parent, ...(cut === undefined ? {} : { cut }) }
  }

  return {
    backend: 'sidecar',
    location: path,
    read() {
      const ownAnchor = readAnchor(keyring, sessionId, channel)
      if (parent !== undefined && ownAnchor === undefined) {
        // Record lineage outside the workspace so grandchildren can recurse through this fork.
        writeAnchor(keyring, { session: sessionId, channel, last: -1, head: '', ...lineageHeader() })
      }
      const result = readLineage(root, keyring, channel, sessionId, undefined, parent === undefined ? undefined : lineageHeader(), new Set())
      const raw = readSidecar(path)
      const chain = verifyChain(raw.lines, keyring, channel, sessionId, raw.tornTail)
      // A reset only "resyncs" while the anchor still confirms everything after it; anchor
      // damage after a reset needs another reset (voiding approval and rules again).
      const resynced = chain.resynced && result.anchorOk
      cursor = { i: chain.next.i, prev: chain.next.prev, needsReset: (chain.needsReset || result.integrity.status !== 'ok') && !resynced, tornTail: chain.tornTail }
      return { records: result.records, integrity: result.integrity, resynced, exists: result.exists }
    },
    append(kind, data) {
      if (cursor === undefined) this.read()
      const state = cursor as { i: number; prev: string; needsReset: boolean; tornTail: boolean }
      let prefix = ''
      if (state.needsReset) {
        // Restart the chain after damage so new evidence is verifiable; trust is not restored.
        const reset = sign(keyring.key, channel, { i: state.i, prev: '', t: Date.now(), logSeq: Number(session.seq), kind: 'reset', data: { reason: 'prior plugin state was damaged' }, session: sessionId })
        prefix = `${state.tornTail ? '\n' : ''}${JSON.stringify(reset)}\n`
        state.i += 1
        state.prev = reset.mac
        state.needsReset = false
        state.tornTail = false
      }
      const record = sign(keyring.key, channel, { i: state.i, prev: state.prev, t: Date.now(), logSeq: Number(session.seq), kind, data, session: sessionId })
      const created = !existsSync(path)
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      const fd = openSync(path, 'a', 0o600)
      try {
        writeSync(fd, `${prefix}${JSON.stringify(record)}\n`)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      if (created) fsyncDir(dirname(path))
      // Anchor after the record is durable: a crash in between leaves one MAC-valid record
      // beyond the anchor, which verification accepts; the reverse could never happen.
      writeAnchor(keyring, { session: sessionId, channel, last: record.i, head: record.mac, ...lineageHeader() })
      state.i += 1
      state.prev = record.mac
      return record
    },
  }
}

/** Plugin-record store: ignorable `plugin:dsh-viztools/<channel>` events in the session log. */
export function createPluginRecordStore(session: StoreSession, channel: StoreChannel, api: PluginRecordApi, keyring: Keyring = loadKeyring()): StateStore {
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
      // Forks carry the parent's records in the seeded log, so the chain spans the lineage.
      const all = lines()
      // Inherited records (inside the fork prefix) belong to the session that wrote them; every
      // later record must belong to this session.
      const cut = Number(session.inheritedEventCount)
      const owner = (record: StoredRecord): string | undefined => record.session === sessionId || record.logSeq <= cut ? record.session : undefined
      const chain = verifyChain(all, keyring, channel, owner)
      const anchor = readAnchor(keyring, sessionId, channel)
      const own = chain.records.some((record) => record.session === sessionId)
      const anchorIntegrity: StoreIntegrity = own || anchor !== undefined ? anchored({ ...chain, records: chain.records.filter((record) => record.session === sessionId) }, anchor, own) : { status: 'ok' }
      const integrity = worst(chain.integrity, anchorIntegrity)
      const resynced = chain.resynced && anchorIntegrity.status === 'ok'
      cursor = { i: chain.next.i, prev: chain.next.prev, needsReset: (chain.needsReset || integrity.status !== 'ok') && !resynced }
      return { records: chain.records, integrity, resynced, exists: all.length > 0 || (anchor !== undefined && anchor !== 'invalid') }
    },
    append(kind, data) {
      if (cursor === undefined) this.read()
      const state = cursor as { i: number; prev: string; needsReset: boolean }
      if (state.needsReset) {
        const reset = sign(keyring.key, channel, { i: state.i, prev: '', t: Date.now(), logSeq: Number(session.seq), kind: 'reset', data: { reason: 'prior plugin state was damaged' }, session: sessionId })
        api.appendPluginRecord(session, type, reset)
        state.i += 1
        state.prev = reset.mac
        state.needsReset = false
      }
      const record = sign(keyring.key, channel, { i: state.i, prev: state.prev, t: Date.now(), logSeq: Number(session.seq), kind, data, session: sessionId })
      api.appendPluginRecord(session, type, record)
      writeAnchor(keyring, { session: sessionId, channel, last: record.i, head: record.mac })
      state.i += 1
      state.prev = record.mac
      return record
    },
  }
}

export interface OpenStoreOptions {
  readonly root: string
  readonly session: StoreSession
  readonly channel: StoreChannel
  readonly keyring: Keyring
  /** Override detection (tests). `null` forces the sidecar. */
  readonly pluginRecords?: PluginRecordApi | null
}

/** Plugin records when DSH supports them, otherwise the rc.2 sidecar. */
export function openStateStore(options: OpenStoreOptions): StateStore {
  const api = options.pluginRecords === null ? undefined : options.pluginRecords ?? detectPluginRecordApi()
  return api === undefined ? createSidecarStore(options.root, options.session, options.channel, options.keyring) : createPluginRecordStore(options.session, options.channel, api, options.keyring)
}
