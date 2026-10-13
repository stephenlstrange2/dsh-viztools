import { appendFile, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Session } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { createSidecarStore, detectPluginRecordApi, openStateStore, verifyChain } from '../src/state-store.js'

const session = (id: string, header: Record<string, unknown> = {}, inherited = 0) => ({ id, seq: 0, header, inheritedEventCount: inherited, snapshotEvents: () => [] })

describe('plugin state sidecar', () => {
  it('appends an fsync-ed, hash-chained, owner-only log per session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'viztools-store-'))
    const store = createSidecarStore(root, session('s1'), 'gate')
    store.append('a', { n: 1 })
    store.append('b', { n: 2 })
    const lines = (await readFile(store.location, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    expect(lines.map((line) => [line.i, line.kind])).toEqual([[0, 'a'], [1, 'b']])
    expect(lines[0].prev).toBe('')
    expect(lines[1].prev).toMatch(/^[0-9a-f]{32}$/)
    expect((await stat(store.location)).mode & 0o777).toBe(0o600)
    const reread = createSidecarStore(root, session('s1'), 'gate').read()
    expect(reread.integrity).toEqual({ status: 'ok' })
    expect(reread.records.map((record) => record.kind)).toEqual(['a', 'b'])
  })

  it('continues the chain across reopen (restart) without breaking integrity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'viztools-store-'))
    createSidecarStore(root, session('s2'), 'gate').append('a', {})
    const reopened = createSidecarStore(root, session('s2'), 'gate')
    reopened.read()
    reopened.append('b', {})
    expect(createSidecarStore(root, session('s2'), 'gate').read()).toMatchObject({ integrity: { status: 'ok' }, exists: true })
  })

  it('detects a torn tail, an edited record, and a deleted record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'viztools-store-'))
    const store = createSidecarStore(root, session('s3'), 'gate')
    for (const kind of ['a', 'b', 'c']) store.append(kind, {})
    const original = await readFile(store.location, 'utf8')
    await writeFile(store.location, original.slice(0, -5))
    expect(createSidecarStore(root, session('s3'), 'gate').read().integrity.status).toBe('truncated')
    const lines = original.trim().split('\n')
    await writeFile(store.location, `${[lines[0], lines[1]?.replace('"b"', '"x"'), lines[2]].join('\n')}\n`)
    expect(createSidecarStore(root, session('s3'), 'gate').read().integrity.status).toBe('truncated')
    await writeFile(store.location, `${[lines[0], lines[2]].join('\n')}\n`)
    expect(createSidecarStore(root, session('s3'), 'gate').read().integrity.status).toBe('truncated')
  })

  it('writes a reset after damage so new evidence is verifiable, without restoring integrity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'viztools-store-'))
    const store = createSidecarStore(root, session('s4'), 'gate')
    store.append('a', {})
    await appendFile(store.location, '{"i":1,"prev":"broken') // torn tail
    const damaged = createSidecarStore(root, session('s4'), 'gate')
    expect(damaged.read()).toMatchObject({ integrity: { status: 'truncated' }, resynced: false })
    damaged.append('after', {})
    const after = createSidecarStore(root, session('s4'), 'gate').read()
    expect(after.integrity.status).toBe('truncated')
    expect(after.resynced).toBe(true)
    expect(after.records.map((record) => record.kind)).toEqual(['a', 'reset', 'after'])
  })

  it('inherits a fork parent\'s records up to the fork point only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'viztools-store-'))
    const parentSession = { ...session('parent'), seq: 0 }
    const parent = createSidecarStore(root, parentSession, 'gate')
    parent.append('before-fork', {})
    parentSession.seq = 10
    parent.append('after-fork', {})
    const child = createSidecarStore(root, session('child', { parentSession: 'parent', isSeeded: true }, 5), 'gate')
    child.append('own', {})
    expect(child.read().records.map((record) => [record.kind, record.session])).toEqual([['before-fork', 'parent'], ['own', 'child']])
  })

  it('rejects unsafe session ids before touching the filesystem', () => {
    expect(() => createSidecarStore('/tmp', session('../escape'), 'gate')).toThrow(/invalid session id/)
  })

  it('verifyChain accepts an empty log', () => {
    expect(verifyChain([]).integrity).toEqual({ status: 'ok' })
  })
})

describe('backend selection', () => {
  it('uses the sidecar on DSH 0.2.0-rc.2, which has no appendPluginRecord', async () => {
    expect(detectPluginRecordApi()).toBeUndefined()
    const root = await mkdtemp(join(tmpdir(), 'viztools-store-'))
    expect(openStateStore({ root, session: Session.create('s5' as never) as never, channel: 'gate' }).backend).toBe('sidecar')
  })

  it('uses plugin records when the DSH module exposes them', () => {
    const api = { appendPluginRecord: () => 0, pluginRecordOf: () => undefined }
    expect(detectPluginRecordApi(api)).toBeDefined()
    expect(openStateStore({ root: '/tmp', session: session('s6'), channel: 'gate', pluginRecords: api }).backend).toBe('plugin-record')
  })
})
