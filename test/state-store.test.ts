import { createHash } from 'node:crypto'
import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Session } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { assertKeyDirOutside, createSidecarStore, detectPluginRecordApi, KeyNotReadyError, loadKeyring, loadKeyringAsync, openStateStore, readAnchor, verifyChain, writeAnchor } from '../src/state-store.js'

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
    expect(verifyChain([], keyring, 'gate', 's0').integrity).toEqual({ status: 'ok' })
  })
})

describe('follow-up hardening (e27dbcf PoCs)', () => {
  it('binds records to their session: a donor session\'s MAC-valid record is rejected in another chain', async () => {
    const { root, keyring } = await fixture()
    const donor = createSidecarStore(root, session('donor'), 'gate', keyring)
    const approval = donor.append('plan-approved', { planCallId: 'p' })
    const victim = createSidecarStore(root, session('victim'), 'gate', keyring)
    victim.append('refused', {})
    const lines = (await readFile(victim.location, 'utf8')).trim().split('\n')
    const last = JSON.parse(lines[0] as string)
    // Keep the donor's MAC but re-point the chain link and claimed session.
    await appendFile(victim.location, `${JSON.stringify({ ...approval, i: 1, prev: last.mac, session: 'victim' })}\n${JSON.stringify({ ...approval, i: 1, prev: last.mac })}\n`)
    const snapshot = createSidecarStore(root, session('victim'), 'gate', keyring).read()
    expect(snapshot.integrity.status).toBe('truncated')
    expect(snapshot.records.map((record) => record.kind)).toEqual(['refused'])
  })

  it('binds records to their channel: a gate record replayed on the report channel is rejected', async () => {
    const { root, keyring } = await fixture()
    const gate = createSidecarStore(root, session('c1'), 'gate', keyring)
    const record = gate.append('plan-approved', {})
    const report = createSidecarStore(root, session('c1'), 'report', keyring)
    await writeFile(report.location, `${JSON.stringify(record)}\n`)
    writeAnchor(keyring, { session: 'c1', channel: 'report', last: 0, head: record.mac })
    expect(createSidecarStore(root, session('c1'), 'report', keyring).read().integrity).toMatchObject({ status: 'truncated', reason: expect.stringMatching(/fails authentication/) })
  })

  it('still verifies sidecars written by e27dbcf (same MAC input for the record\'s own session)', async () => {
    const { root, keyring } = await fixture()
    const { createHmac } = await import('node:crypto')
    const body = { i: 0, prev: '', t: 1, logSeq: 3, kind: 'plan-approved', data: { planCallId: 'p' }, session: 'old' }
    const mac = createHmac('sha256', keyring.key).update(JSON.stringify({ v: 1, channel: 'gate', session: body.session, i: body.i, prev: body.prev, t: body.t, logSeq: body.logSeq, kind: body.kind, data: body.data })).digest('hex')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'old.gate.jsonl'), `${JSON.stringify({ ...body, mac })}\n`)
    writeAnchor(keyring, { session: 'old', channel: 'gate', last: 0, head: mac })
    expect(createSidecarStore(root, session('old'), 'gate', keyring).read()).toMatchObject({ integrity: { status: 'ok' }, records: [{ kind: 'plan-approved' }] })
  })

  it('accepts at most one MAC-valid record beyond the anchor', async () => {
    const { root, keyring } = await fixture()
    const store = createSidecarStore(root, session('b1'), 'gate', keyring)
    const first = store.append('a', {})
    store.append('b', {})
    store.append('c', {})
    // Roll the anchor back two records (e.g. an anchor restored from an older backup).
    writeAnchor(keyring, { session: 'b1', channel: 'gate', last: first.i, head: first.mac })
    expect(createSidecarStore(root, session('b1'), 'gate', keyring).read().integrity).toMatchObject({ status: 'truncated', reason: expect.stringMatching(/not the last record/) })
  })

  it('creates the key race-safely (temp + link)', async () => {
    const { base } = await fixture()
    const dir = join(base, 'race', 'viztools')
    const created = loadKeyring(dir)
    expect(loadKeyring(dir).key.equals(created.key)).toBe(true)
    const { readdir: list } = await import('node:fs/promises')
    expect((await list(dir)).filter((name) => name.startsWith('.sidecar.key.'))).toEqual([])
  })

  it('never blocks on an empty key file: sync load fails fast, async load retries on timers', async () => {
    const { base } = await fixture()
    const slow = join(base, 'slow', 'viztools')
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(slow, { recursive: true, mode: 0o700 })
    writeFileSync(join(slow, 'sidecar.key'), '', { mode: 0o600 })
    const started = Date.now()
    expect(() => loadKeyring(slow)).toThrow(KeyNotReadyError)
    expect(Date.now() - started).toBeLessThan(50)
    // The event loop stays free while the async loader waits: a timer fills the key in.
    setTimeout(() => writeFileSync(join(slow, 'sidecar.key'), 'b'.repeat(64)), 60)
    const ticks: number[] = []
    const ticker = setInterval(() => ticks.push(Date.now()), 10)
    const loaded = await loadKeyringAsync(slow)
    clearInterval(ticker)
    expect(loaded.key.toString('hex')).toBe('b'.repeat(64))
    expect(ticks.length).toBeGreaterThan(2)
  })

  it('upgrades an own 0755 key directory to 0700 with a notice, and explains a leaked key file', async () => {
    const { base } = await fixture()
    const { chmod, stat: statFile } = await import('node:fs/promises')
    const dir = join(base, 'perm', 'viztools')
    loadKeyring(dir)
    await chmod(dir, 0o755)
    const upgraded = loadKeyring(dir)
    expect(upgraded.notices?.[0]).toMatch(/tightened .* from mode 755 to 700/)
    expect((await statFile(dir)).mode & 0o777).toBe(0o700)
    await chmod(join(dir, 'sidecar.key'), 0o644)
    expect(() => loadKeyring(dir)).toThrow(/key may have leaked\. Rotate it: stop the console, delete .*sidecar\.key and .*anchors/)
  })

  it('refuses a group/other-WRITABLE key directory instead of silently tightening it (8bbc07f LOW 2)', async () => {
    const { base } = await fixture()
    const { chmod, stat: statFile } = await import('node:fs/promises')
    for (const mode of [0o775, 0o777, 0o730]) {
      const dir = join(base, `writable-${mode.toString(8)}`, 'viztools')
      loadKeyring(dir)
      await chmod(dir, mode)
      expect(() => loadKeyring(dir)).toThrow(/writable by group or others .*not tightened automatically/)
      expect((await statFile(dir)).mode & 0o777).toBe(mode)
    }
    // Read-only exposure (0755) is still tightened, as before.
    const readable = join(base, 'readable', 'viztools')
    loadKeyring(readable)
    await chmod(readable, 0o755)
    expect(loadKeyring(readable).notices?.[0]).toMatch(/from mode 755 to 700/)
  })

  it('does not trust a linked or group/other-writable anchor file', async () => {
    const { root, keyring, base } = await fixture()
    const { chmod, rename, symlink } = await import('node:fs/promises')
    const store = createSidecarStore(root, session('an1'), 'gate', keyring)
    store.append('a', {})
    const anchor = join(keyring.dir, 'anchors', 'an1.gate.json')
    await chmod(anchor, 0o666)
    expect(readAnchor(keyring, 'an1', 'gate')).toBe('invalid')
    expect(createSidecarStore(root, session('an1'), 'gate', keyring).read().integrity).toMatchObject({ status: 'truncated', reason: expect.stringMatching(/anchor fails authentication/) })
    await chmod(anchor, 0o600)
    expect(readAnchor(keyring, 'an1', 'gate')).toMatchObject({ last: 0 })
    // A symlink to an otherwise valid anchor (e.g. planted from elsewhere) is not trusted either.
    const elsewhere = join(base, 'elsewhere.json')
    await rename(anchor, elsewhere)
    await symlink(elsewhere, anchor)
    expect(readAnchor(keyring, 'an1', 'gate')).toBe('invalid')
  })

  it('refuses a key directory whose parent is group/other-writable without the sticky bit (3526c45 LOW 3)', async () => {
    const { base } = await fixture()
    const { chmod, mkdir } = await import('node:fs/promises')
    const open = join(base, 'open-parent')
    await mkdir(open)
    await chmod(open, 0o777)
    expect(() => loadKeyring(join(open, 'viztools'))).toThrow(/writable by group or others without the sticky bit/)
    await chmod(open, 0o1777) // sticky, like /tmp: owners only can rename their entries
    expect(() => loadKeyring(join(open, 'viztools'))).not.toThrow()
    const group = join(base, 'group-parent')
    await mkdir(group)
    await chmod(group, 0o770)
    expect(() => loadKeyring(join(group, 'viztools'))).toThrow(/without the sticky bit/)
  })

  it('compares the key directory with the workspace by realpath', async () => {
    const { base } = await fixture()
    const { mkdir, symlink } = await import('node:fs/promises')
    await mkdir(join(base, 'workspace'), { recursive: true })
    await symlink(join(base, 'workspace'), join(base, 'alias'))
    expect(() => assertKeyDirOutside(join(base, 'alias', 'keys'), join(base, 'workspace'))).toThrow(/outside the workspace/)
  })
})

describe('same-session replay (804fbef PoC r1)', () => {
  const rules = (allow: string[]) => ({ version: 3, allow, deny: [], limits: {}, notes: [], deploymentFingerprint: 'x' })

  async function damagedThenNarrowed() {
    const { root, keyring } = await fixture()
    const store = createSidecarStore(root, session('c'), 'gate', keyring)
    store.append('refused', { callId: 'c', tool: 't', code: 'X', reason: 'r' })
    await appendFile(store.location, 'garbage\n')
    const writer = createSidecarStore(root, session('c'), 'gate', keyring)
    writer.read()
    writer.append('plan-approved', { planCallId: 'p' }) // writes reset + approval
    writer.append('rules-approved', { callId: 'r1', rules: rules(['x', 'y']) as never })
    writer.append('rules-approved', { callId: 'r2', rules: rules(['x']) as never }) // narrowing
    return { root, keyring, location: store.location }
  }

  it('re-appending the session\'s own old reset + approval + wider rules fails closed', async () => {
    const { root, keyring, location } = await damagedThenNarrowed()
    const lines = (await readFile(location, 'utf8')).trim().split('\n')
    const reset = lines.findIndex((line) => line.includes('"kind":"reset"'))
    await appendFile(location, `${lines.slice(reset, reset + 3).join('\n')}\n`)
    const snapshot = createSidecarStore(root, session('c'), 'gate', keyring).read()
    // Not resynced: the gate must write a fresh reset (approval and rules void again).
    expect(snapshot.resynced).toBe(false)
    const { foldGateRecords } = await import('../src/gate-state.js')
    expect(foldGateRecords(snapshot.records).rules?.allow).toEqual(['x'])
    // The next append is a reset with an index above everything in the file.
    const writer = createSidecarStore(root, session('c'), 'gate', keyring)
    writer.read()
    writer.append('refused', { callId: 'after', tool: 't', code: 'X', reason: 'r' })
    const indices = (await readFile(location, 'utf8')).trim().split('\n').flatMap((line) => { try { return [JSON.parse(line)] } catch { return [] } })
    // File so far: #0, garbage, reset #1, #2, #3, #4, replayed #1-#3 → the fresh reset must be #5.
    const fresh = (indices as { kind: string; i: number }[]).filter((record) => record.kind === 'reset').at(-1)
    expect(fresh?.i).toBe(5)
    expect((indices as { i: number }[]).at(-1)?.i).toBe(6)
    const after = createSidecarStore(root, session('c'), 'gate', keyring).read()
    expect(after.resynced).toBe(true)
    const fold = foldGateRecords(after.records)
    expect(fold.approved).toBe(false)
    expect(fold.rulesInvalid).toBeDefined()
  })

  it('rejects a replayed old reset even when it is the only thing appended', async () => {
    const { root, keyring, location } = await damagedThenNarrowed()
    const lines = (await readFile(location, 'utf8')).trim().split('\n')
    await appendFile(location, `${lines.find((line) => line.includes('"kind":"reset"'))}\n`)
    expect(createSidecarStore(root, session('c'), 'gate', keyring).read()).toMatchObject({ resynced: false, integrity: { status: 'truncated' } })
  })

  it('requires the anchored head to be the last record: one MAC-valid older record after it fails', async () => {
    const { root, keyring } = await fixture()
    const store = createSidecarStore(root, session('h'), 'gate', keyring)
    store.append('a', {})
    store.append('b', {})
    const lines = (await readFile(store.location, 'utf8')).trim().split('\n')
    await appendFile(store.location, `${lines[0]}\n`)
    expect(createSidecarStore(root, session('h'), 'gate', keyring).read().integrity).toMatchObject({ status: 'truncated', reason: expect.stringMatching(/repeats or reorders|not the last record/) })
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
