import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateStoredEvents } from '@deepseek-ai/dsh-session-persistence'
import { describe, expect, it } from 'vitest'
import { foldGateRecords } from '../src/gate-state.js'
import { acquireSessionLease, repairSessions } from '../src/repair.js'
import { createSidecarStore, loadKeyring } from '../src/state-store.js'

const id = 'session-11111111-2222-3333-4444-555555555555'

function legacyLog(): string {
  const header = { type: 'session', version: 4, id, createdAt: 1, cwd: '/w', isSeeded: false, delegationDepth: 0 }
  const events = [
    { type: 'plan/mode', seq: 0, time: 1, data: { active: true } },
    { type: 'viztools-gate/change', seq: 1, time: 2, data: { kind: 'refused', version: 1, callId: 'c1', tool: 'mcp__otx__replay_tx_only', reason: 'Plan not approved yet.' } },
    { type: 'viztools-gate/change', seq: 2, time: 3, data: { kind: 'approved', version: 1, planCallId: 'plan' } },
    { type: 'viztools-run-rules/change', seq: 3, time: 4, data: { kind: 'approved', version: 2, callId: 'r', rules: { version: 2, allow: [], deny: ['mcp__otx__emit_otx'], limits: { mcp__otx__replay_tx_only: 2 }, notes: [], deploymentFingerprint: 'f' } } },
    { type: 'viztools-run-rules/change', seq: 4, time: 5, data: { kind: 'accepted-call', version: 2, callId: 'c2', tool: 'mcp__otx__replay_tx_only' } },
    { type: 'viztools-report/change', seq: 5, time: 6, data: { kind: 'available', version: 1, triggerSeq: 4, trigger: 'tool:mcp__otx__finalize_run', templateVersion: '1', notebook: 'n', html: 'h', inputs: 'i' } },
  ]
  return `${[header, ...events].map((line) => JSON.stringify(line)).join('\n')}\n`
}

async function home(compressed: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'viztools-repair-'))
  const dir = join(root, 'home', 'sessions', '--w--', id)
  await mkdir(dir, { recursive: true })
  const log = join(dir, compressed ? 'session.v4.jsonl.zstd' : 'session.v4.jsonl')
  if (compressed) {
    // DSH layout: the header line is its own first frame, events follow in later frames.
    const [header, ...rest] = legacyLog().split(/(?<=\n)/)
    await writeFile(log, Buffer.concat([execFileSync('zstd', ['-q', '-c', '-'], { input: header }), execFileSync('zstd', ['-q', '-c', '-'], { input: rest.join('') })]))
  }
  else await writeFile(log, legacyLog())
  await mkdir(join(root, 'home', 'storages', 'session_projcache', 'sessions'), { recursive: true })
  await writeFile(join(root, 'home', 'storages', 'session_projcache', 'sessions', `${id}.json`), '{}')
  return { root, dshHome: join(root, 'home'), workspace: join(root, 'ws'), log, dir }
}

function events(text: string) {
  return text.trim().split('\n').slice(1).map((line) => JSON.parse(line))
}

const zstdAvailable = (() => { try { execFileSync('zstd', ['--version']); return true } catch { return false } })()

describe('dsh-viztools-repair', () => {
  it('reproduces the rc.2 refusal on a legacy log', async () => {
    const { log } = await home(false)
    const legacy = events(await readFile(log, 'utf8'))
    expect(() => validateStoredEvents({ id, version: 4 } as never, legacy, log as never)).toThrow(/unknown to this harness and not marked ignorable/)
  })

  it('dry-run reports but writes nothing', async () => {
    const h = await home(false)
    const before = await readFile(h.log, 'utf8')
    const [result] = await repairSessions({ dshHome: h.dshHome, workspace: h.workspace, dryRun: true })
    expect(result).toMatchObject({ sessionId: id, legacyEvents: 5, action: 'would-convert', exported: { gate: 4, report: 1 } })
    expect(await readFile(h.log, 'utf8')).toBe(before)
    expect(existsSync(join(h.workspace, '.dsh/viztools/state'))).toBe(false)
    expect((await readdir(h.dir)).some((name) => name.includes('viztools-backup'))).toBe(false)
  })

  it('backs up, converts in place (seq preserved), exports state, and DSH then accepts the log', async () => {
    const h = await home(false)
    const before = await readFile(h.log, 'utf8')
    const [result] = await repairSessions({ dshHome: h.dshHome, workspace: h.workspace, dryRun: false, now: () => 42 })
    expect(result).toMatchObject({ action: 'converted', legacyEvents: 5 })
    const backups = (await readdir(h.dir)).filter((name) => name.startsWith('session.v4.jsonl.viztools-backup-42-'))
    expect(backups).toHaveLength(1)
    expect(await readFile(join(h.dir, backups[0] as string), 'utf8')).toBe(before)
    expect((await readdir(h.dir)).some((name) => name.includes('viztools-repair-'))).toBe(false)
    // DSH lists sessions from the projection cache; the repair must leave it in place.
    expect(existsSync(join(h.dshHome, 'storages', 'session_projcache', 'sessions', `${id}.json`))).toBe(true)
    const repaired = events(await readFile(h.log, 'utf8'))
    expect(repaired.map((event) => event.seq)).toEqual([0, 1, 2, 3, 4, 5])
    expect(repaired.filter((event) => String(event.type).startsWith('viztools')).every((event) => event.ignorable === true)).toBe(true)
    expect(() => validateStoredEvents({ id, version: 4 } as never, repaired, h.log as never)).not.toThrow()
    const fake = { id, seq: 0, header: {}, inheritedEventCount: 0, snapshotEvents: () => [] }
    const fold = foldGateRecords(createSidecarStore(join(h.workspace, '.dsh/viztools/state'), fake, 'gate', loadKeyring(join(h.dshHome, 'viztools'))).read().records)
    expect(fold).toMatchObject({ approved: true, counts: { mcp__otx__replay_tx_only: 1 } })
    expect(fold.rules?.allow).toBeUndefined()
    expect(fold.refusals[0]).toMatchObject({ code: 'PLAN_NOT_APPROVED', beforeApproval: true })
    // Idempotent: a second run finds nothing to do.
    expect((await repairSessions({ dshHome: h.dshHome, workspace: h.workspace, dryRun: false }))[0]?.action).toBe('clean')
  })

  it.skipIf(!zstdAvailable)('repairs zstd-compressed v4 logs', async () => {
    const h = await home(true)
    const [result] = await repairSessions({ dshHome: h.dshHome, workspace: h.workspace, dryRun: false })
    expect(result?.action).toBe('converted')
    const repaired = events(execFileSync('zstd', ['-dc', h.log]).toString('utf8'))
    expect(() => validateStoredEvents({ id, version: 4 } as never, repaired, h.log as never)).not.toThrow()
    // DSH's session lister decodes only the first frame: it must still be exactly the header.
    const first = zstdDecompressSync(readFileSync(h.log)).toString('utf8').split('\n').filter(Boolean)
    expect(first).toHaveLength(1)
    expect(JSON.parse(first[0] as string)).toMatchObject({ type: 'session', id })
  })

  it('does not re-import when a sidecar already exists', async () => {
    const h = await home(false)
    const fake = { id, seq: 0, header: {}, inheritedEventCount: 0, snapshotEvents: () => [] }
    createSidecarStore(join(h.workspace, '.dsh/viztools/state'), fake, 'gate', loadKeyring(join(h.dshHome, 'viztools'))).append('plan-approved', { planCallId: 'existing' })
    const [result] = await repairSessions({ dshHome: h.dshHome, workspace: h.workspace, dryRun: false })
    expect(result?.exported.skipped).toMatch(/already exists/)
    expect(foldGateRecords(createSidecarStore(join(h.workspace, '.dsh/viztools/state'), fake, 'gate', loadKeyring(join(h.dshHome, 'viztools'))).read().records).planCallId).toBe('existing')
  })

  it('refuses a session while DSH holds its lease, and repairs it once the lease is free', async () => {
    const h = await home(false)
    const before = await readFile(h.log, 'utf8')
    const dsh = await acquireSessionLease(h.dir)
    try {
      const [result] = await repairSessions({ dshHome: h.dshHome, workspace: h.workspace, dryRun: false })
      expect(result).toMatchObject({ action: 'failed', error: expect.stringMatching(/DSH holds the session lease/) })
      expect(await readFile(h.log, 'utf8')).toBe(before)
    } finally {
      await dsh.release()
    }
    expect((await repairSessions({ dshHome: h.dshHome, workspace: h.workspace, dryRun: false }))[0]?.action).toBe('converted')
  })

  it('never follows a planted temp-file symlink (unique, exclusive temp names)', async () => {
    const h = await home(false)
    const victim = join(h.root, 'victim.txt')
    await writeFile(victim, 'untouched')
    const { symlink } = await import('node:fs/promises')
    // PoC against the old fixed temp name.
    await symlink(victim, `${h.log}.viztools-repair-tmp`)
    expect((await repairSessions({ dshHome: h.dshHome, workspace: h.workspace, dryRun: false }))[0]?.action).toBe('converted')
    expect(await readFile(victim, 'utf8')).toBe('untouched')
  })

  it('does not re-export a fork\'s inherited legacy events, and the fork inherits them via lineage', async () => {
    const h = await home(false)
    await repairSessions({ dshHome: h.dshHome, workspace: h.workspace, dryRun: false })
    // The child repeats the parent's six events, then its own cut marker and one own legacy event.
    const childId = 'session-99999999-2222-3333-4444-555555555555'
    const parentLines = legacyLog().trim().split('\n').slice(1)
    const childHeader = { type: 'session', version: 4, id: childId, createdAt: 2, cwd: '/w', isSeeded: true, parentSession: id, delegationDepth: 0 }
    const own = [
      { type: 'session/end-seed', seq: 6, time: 7, data: { inherited: true } },
      { type: 'viztools-run-rules/change', seq: 7, time: 8, data: { kind: 'accepted-call', version: 2, callId: 'c-child', tool: 'mcp__otx__replay_tx_only' } },
    ]
    const childDir = join(h.dshHome, 'sessions', '--w--', childId)
    await mkdir(childDir, { recursive: true })
    await writeFile(join(childDir, 'session.v4.jsonl'), `${[JSON.stringify(childHeader), ...parentLines, ...own.map((event) => JSON.stringify(event))].join('\n')}\n`)
    const results = await repairSessions({ dshHome: h.dshHome, workspace: h.workspace, dryRun: false, sessions: [childId] })
    expect(results[0]).toMatchObject({ action: 'converted', legacyEvents: 6, inherited: 5, exported: { gate: 1, report: 0 } })
    const keyring = loadKeyring(join(h.dshHome, 'viztools'))
    const child = { id: childId, seq: 8, header: { isSeeded: true, parentSession: id }, inheritedEventCount: 6, snapshotEvents: () => [] }
    const snapshot = createSidecarStore(join(h.workspace, '.dsh/viztools/state'), child, 'gate', keyring).read()
    expect(snapshot.integrity).toEqual({ status: 'ok' })
    const fold = foldGateRecords(snapshot.records)
    expect(fold).toMatchObject({ approved: true, counts: { mcp__otx__replay_tx_only: 2 } })
    expect(snapshot.records.filter((record) => record.session === childId).map((record) => record.data.callId)).toEqual(['c-child'])
  })
})
