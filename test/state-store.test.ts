import { createHash } from 'node:crypto'
import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Session } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { assertKeyDirOutside, createSidecarStore, detectPluginRecordApi, loadKeyring, openStateStore, readAnchor, verifyChain, writeAnchor } from '../src/state-store.js'

const session = (id: string, header: Record<string, unknown> = {}, inherited = 0) => ({ id, seq: 0, header, inheritedEventCount: inherited, snapshotEvents: () => [] })

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'viztools-store-'))
  const root = join(base, 'workspace', '.dsh', 'viztools', 'state')
  const keyring = loadKeyring(join(base, 'dsh-home', 'viztools'))
  return { base, root, keyring }
}

describe('keyed plugin state sidecar', () => {
  it('appends an fsync-ed, HMAC-chained, owner-only log and an anchor outside the workspace', async () => {
    const { root, keyring } = await fixture()
    const store = createSidecarStore(root, session('s1'), 'gate', keyring)
    store.append('a', { n: 1 })
    const second = store.append('b', { n: 2 })
    const lines = (await readFile(store.location, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    expect(lines.map((line) => [line.i, line.kind])).toEqual([[0, 'a'], [1, 'b']])
    expect(lines[0].prev).toBe('')
    expect(lines[1].prev).toBe(lines[0].mac)
    expect(lines[1].mac).toMatch(/^[0-9a-f]{64}$/)
    expect((await stat(store.location)).mode & 0o777).toBe(0o600)
    expect((await stat(join(keyring.dir, 'sidecar.key'))).mode & 0o777).toBe(0o600)
    expect(readAnchor(keyring, 's1', 'gate')).toMatchObject({ last: 1, head: second.mac })
    expect(createSidecarStore(root, session('s1'), 'gate', keyring).read()).toMatchObject({ integrity: { status: 'ok' }, exists: true })
  })

  it('rejects a forged append whose hash chain is valid but which lacks the key', async () => {
    const { root, keyring } = await fixture()
    const store = createSidecarStore(root, session('s2'), 'gate', keyring)
    const first = store.append('refused', { callId: 'c1', tool: 'replay' })
    // PoC: an attacker with workspace write recomputes an unkeyed SHA-256 "MAC" and appends approval.
    const forged = { i: 1, prev: first.mac, t: Date.now(), logSeq: 1, kind: 'plan-approved', data: { planCallId: 'forged' }, session: 's2' }
    const mac = createHash('sha256').update(JSON.stringify(forged)).digest('hex')
    await appendFile(store.location, `${JSON.stringify({ ...forged, mac })}\n`)
    const snapshot = createSidecarStore(root, session('s2'), 'gate', keyring).read()
    expect(snapshot.integrity).toMatchObject({ status: 'truncated', reason: expect.stringMatching(/fails authentication/) })
    expect(snapshot.records.map((record) => record.kind)).toEqual(['refused'])
  })

  it('detects tail truncation of whole, valid records through the anchor', async () => {
    const { root, keyring } = await fixture()
    const store = createSidecarStore(root, session('s3'), 'gate', keyring)
    for (const kind of ['a', 'b', 'started']) store.append(kind, {})
    const lines = (await readFile(store.location, 'utf8')).trim().split('\n')
    // PoC: drop the last complete record; the remaining chain is internally consistent.
    await writeFile(store.location, `${lines.slice(0, 2).join('\n')}\n`)
    expect(createSidecarStore(root, session('s3'), 'gate', keyring).read().integrity).toMatchObject({ status: 'truncated', reason: expect.stringMatching(/missing/) })
  })

  it('treats a deleted sidecar with a surviving anchor as missing state', async () => {
    const { root, keyring } = await fixture()
    const store = createSidecarStore(root, session('s4'), 'gate', keyring)
    store.append('plan-approved', {})
    await rm(store.location)
    expect(createSidecarStore(root, session('s4'), 'gate', keyring).read().integrity.status).toBe('missing')
  })

  it('rejects a tampered or missing anchor', async () => {
    const { root, keyring } = await fixture()
    const store = createSidecarStore(root, session('s5'), 'gate', keyring)
    store.append('a', {})
    const anchor = join(keyring.dir, 'anchors', 's5.gate.json')
    const value = JSON.parse(await readFile(anchor, 'utf8'))
    await writeFile(anchor, JSON.stringify({ ...value, last: 7 }))
    expect(createSidecarStore(root, session('s5'), 'gate', keyring).read().integrity).toMatchObject({ status: 'truncated', reason: expect.stringMatching(/anchor fails authentication/) })
    await rm(anchor)
    expect(createSidecarStore(root, session('s5'), 'gate', keyring).read().integrity).toMatchObject({ status: 'truncated', reason: expect.stringMatching(/anchor is missing/) })
  })

  it('accepts a MAC-valid record beyond the anchor (crash between record and anchor) and a torn final line', async () => {
    const { root, keyring } = await fixture()
    const store = createSidecarStore(root, session('s6'), 'gate', keyring)
    const first = store.append('a', {})
    store.append('b', {})
    writeAnchor(keyring, { session: 's6', channel: 'gate', last: first.i, head: first.mac })
    await appendFile(store.location, '{"i":2,"prev":"tor')
    const snapshot = createSidecarStore(root, session('s6'), 'gate', keyring).read()
    expect(snapshot.integrity).toEqual({ status: 'ok' })
    expect(snapshot.records.map((record) => record.kind)).toEqual(['a', 'b'])
  })

  it('writes a reset after damage so new evidence is verifiable, without restoring integrity', async () => {
    const { root, keyring } = await fixture()
    const store = createSidecarStore(root, session('s7'), 'gate', keyring)
    store.append('a', {})
    store.append('b', {})
    const lines = (await readFile(store.location, 'utf8')).trim().split('\n')
    await writeFile(store.location, `${lines[0]}\n`)
    const damaged = createSidecarStore(root, session('s7'), 'gate', keyring)
    expect(damaged.read()).toMatchObject({ integrity: { status: 'truncated' }, resynced: false })
    damaged.append('after', {})
    const after = createSidecarStore(root, session('s7'), 'gate', keyring).read()
    expect(after.integrity.status).toBe('truncated')
    expect(after.resynced).toBe(true)
    expect(after.records.map((record) => record.kind)).toEqual(['a', 'reset', 'after'])
  })

  it('inherits fork lineage recursively (grandchildren) up to each fork point', async () => {
    const { root, keyring } = await fixture()
    const parentSession = { ...session('parent'), seq: 0 }
    const parent = createSidecarStore(root, parentSession, 'gate', keyring)
    parent.append('parent-early', {})
    parentSession.seq = 10
    parent.append('parent-late', {})
    const childSession = { ...session('child', { parentSession: 'parent', isSeeded: true }, 5), seq: 6 }
    const child = createSidecarStore(root, childSession, 'gate', keyring)
    child.read()
    child.append('child-early', {})
    childSession.seq = 20
    child.append('child-late', {})
    const grandchild = createSidecarStore(root, session('grandchild', { parentSession: 'child', isSeeded: true }, 8), 'gate', keyring)
    expect(grandchild.read().records.map((record) => [record.kind, record.session])).toEqual([['parent-early', 'parent'], ['child-early', 'child']])
  })

  it('rejects unsafe session ids and a key directory inside the workspace', async () => {
    const { keyring, base } = await fixture()
    expect(() => createSidecarStore('/tmp', session('../escape'), 'gate', keyring)).toThrow(/invalid session id/)
    expect(() => assertKeyDirOutside(join(base, 'workspace', '.keys'), join(base, 'workspace'))).toThrow(/outside the workspace/)
    expect(() => assertKeyDirOutside(join(base, 'dsh-home', 'viztools'), join(base, 'workspace'))).not.toThrow()
  })

  it('verifyChain accepts an empty log', async () => {
    const { keyring } = await fixture()
    expect(verifyChain([], keyring, 'gate').integrity).toEqual({ status: 'ok' })
  })
})

describe('backend selection', () => {
  it('uses the sidecar on DSH 0.2.0-rc.2, which has no appendPluginRecord', async () => {
    const { root, keyring } = await fixture()
    expect(detectPluginRecordApi()).toBeUndefined()
    expect(openStateStore({ root, session: Session.create('s8' as never) as never, channel: 'gate', keyring }).backend).toBe('sidecar')
  })

  it('uses plugin records when the DSH module exposes them', async () => {
    const { root, keyring } = await fixture()
    const api = { appendPluginRecord: () => 0, pluginRecordOf: () => undefined }
    expect(detectPluginRecordApi(api)).toBeDefined()
    expect(openStateStore({ root, session: session('s9'), channel: 'gate', pluginRecords: api, keyring }).backend).toBe('plugin-record')
  })
})
