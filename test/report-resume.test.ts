import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { Session } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { publishManagedState, managedStatePath } from '../src/managed-state.js'
import * as report from '../src/report.js'

async function boot(cwd: string, extra: Record<string, unknown> = {}) {
  const ctx = new Context()
  ctx.provide('sessionPersistence', { flush: async () => undefined } as never)
  await ctx.plugin(report as never, { enabled: true, cwd, outputDir: '.dsh/reports', triggerTools: ['mcp__otx__finalize_run'], ...extra } as never).await()
  return ctx
}

function created(ctx: Context, id: string) {
  const agent = { id, session: Session.create(id as never), ctx }
  ;(ctx as unknown as { emit: (...args: unknown[]) => void }).emit('agent/created', { agent })
}

async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 5))
}

describe('report state across resume', () => {
  it('seeds pending only when no state exists', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'viztools-resume-'))
    const ctx = await boot(cwd)
    created(ctx, 'fresh')
    await settle()
    expect(JSON.parse(await readFile(managedStatePath(join(cwd, '.dsh/reports'), 'fresh'), 'utf8')).status).toBe('pending')
  })

  it('keeps an available or failed report when the agent is resumed', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'viztools-resume-'))
    const root = join(cwd, '.dsh/reports')
    await publishManagedState(root, { status: 'available', sessionId: 'done', html: join(root, 'done', 'report.html'), updatedAt: 7 })
    await publishManagedState(root, { status: 'failed', sessionId: 'broken', reason: 'timeout', updatedAt: 8 })
    const ctx = await boot(cwd)
    created(ctx, 'done')
    created(ctx, 'broken')
    await settle()
    expect(JSON.parse(await readFile(managedStatePath(root, 'done'), 'utf8'))).toMatchObject({ status: 'available', updatedAt: 7 })
    expect(JSON.parse(await readFile(managedStatePath(root, 'broken'), 'utf8'))).toMatchObject({ status: 'failed', updatedAt: 8 })
  })

  it('never surfaces an unhandled rejection for an unsafe session id', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'viztools-resume-'))
    const ctx = await boot(cwd)
    const unhandled: unknown[] = []
    const listener = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', listener)
    try {
      created(ctx, '../escape')
      await settle()
    } finally {
      process.off('unhandledRejection', listener)
    }
    expect(unhandled).toEqual([])
  })

  it('loads with an unusable keyDir (inside the workspace) instead of throwing', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'viztools-resume-'))
    const ctx = await boot(cwd, { keyDir: join(cwd, '.keys') })
    created(ctx, 'keyless')
    await settle()
    expect(JSON.parse(await readFile(managedStatePath(join(cwd, '.dsh/reports'), 'keyless'), 'utf8')).status).toBe('pending')
  })

  it('retries a report whose key is still being written instead of disabling reports (8bbc07f LOW 3)', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises')
    const cwd = await mkdtemp(join(tmpdir(), 'viztools-resume-'))
    const keyDir = join(await mkdtemp(join(tmpdir(), 'viztools-keys-')), 'k')
    await mkdir(keyDir, { mode: 0o700 })
    await writeFile(join(keyDir, 'sidecar.key'), '', { mode: 0o600 }) // another process is still writing it
    const ctx = new Context()
    ctx.provide('sessionPersistence', { flush: async () => undefined } as never)
    const config = report.Config({ enabled: true, cwd, outputDir: '.dsh/reports', triggerOnTurnStop: true, keyDir })
    await ctx.plugin({ name: 'report-hooked', inject: report.inject, apply: (inner: Context) => report.apply(inner, config, { keyRetryDelayMs: 100 }) } as never, {} as never).await()
    const agent = { id: 'kr1', session: Session.create('kr1' as never), ctx }
    ;(ctx as unknown as { emit: (...args: unknown[]) => void }).emit('agent/turn-stopping', { agent, turn: 1 })
    const statePath = managedStatePath(join(cwd, '.dsh/reports'), 'kr1')
    let state: { status: string; reason?: string } | undefined
    for (let i = 0; i < 80 && !/not ready yet/.test(state?.reason ?? ''); i++) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      state = JSON.parse(await readFile(statePath, 'utf8').catch(() => '{}'))
    }
    expect(state?.reason).toMatch(/Report key is not ready yet; waiting up to/)
    // The key arrives; the very same report is retried and now records its outcome durably.
    await writeFile(join(keyDir, 'sidecar.key'), 'd'.repeat(64))
    const sidecar = join(cwd, '.dsh/viztools/state', 'kr1.report.jsonl')
    let records = ''
    for (let i = 0; i < 80 && records === ''; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      records = await readFile(sidecar, 'utf8').catch(() => '')
    }
    expect(records).toMatch(/"kind":"failed"/) // no real marimo here: the export fails, but the outcome is stored
    state = JSON.parse(await readFile(statePath, 'utf8'))
    expect(state?.reason ?? '').not.toMatch(/key/)
  }, 20_000)

  async function keyless() {
    const { mkdir, writeFile } = await import('node:fs/promises')
    const cwd = await mkdtemp(join(tmpdir(), 'viztools-resume-'))
    const keyDir = join(await mkdtemp(join(tmpdir(), 'viztools-keys-')), 'k')
    await mkdir(keyDir, { mode: 0o700 })
    await writeFile(join(keyDir, 'sidecar.key'), '', { mode: 0o600 })
    const ctx = new Context()
    const warnings: string[] = []
    ;(ctx as unknown as { logger: unknown }).logger = { warn: (text: string) => warnings.push(text), info() {}, error() {} }
    ctx.provide('sessionPersistence', { flush: async () => undefined } as never)
    const config = (report.Config as unknown as (value: Record<string, unknown>) => report.ResolvedConfig)({ enabled: true, cwd, outputDir: '.dsh/reports', triggerOnTurnStop: true, keyDir })
    await ctx.plugin({ name: 'report-hooked', inject: report.inject, apply: (inner: Context) => report.apply(inner, config, { keyRetryDelayMs: 20 }) } as never, {} as never).await()
    const agent = { id: 'kg1', session: Session.create('kg1' as never), ctx }
    const stop = (turn: number) => (ctx as unknown as { emit: (...args: unknown[]) => void }).emit('agent/turn-stopping', { agent, turn })
    return { cwd, keyDir, stop, warnings, agent, statePath: managedStatePath(join(cwd, '.dsh/reports'), 'kg1') }
  }

  it('publishes a "gave up" state after the whole retry window, measured end to end (3526c45 LOW 3)', async () => {
    const h = await keyless()
    const started = Date.now()
    h.stop(1)
    let state: { reason?: string } = {}
    for (let i = 0; i < 200 && !/Gave up/.test(state.reason ?? ''); i++) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      state = JSON.parse(await readFile(h.statePath, 'utf8').catch(() => '{}'))
    }
    const elapsed = Date.now() - started
    expect(state.reason).toMatch(/^Gave up: the report key was not ready/)
    expect(state.reason).not.toMatch(/retrying \(12\/12\)/)
    // 12 x 20 ms window: no inner wait multiplies it (the old code waited ~1 s per attempt).
    expect(elapsed).toBeLessThan(2_000)
    expect(elapsed).toBeGreaterThanOrEqual(12 * 20 - 30)
  }, 20_000)

  it('de-duplicates concurrent retries: one shared key wait, one waiter per report', async () => {
    const h = await keyless()
    const { readdir } = await import('node:fs/promises')
    for (let i = 0; i < 5; i++) h.stop(1) // the same turn reported five times
    await new Promise((resolve) => setTimeout(resolve, 0)) // let turn 1 capture its sequence
    ;(h.agent.session as unknown as { append(type: string, data: unknown): void }).append('plan/mode', { active: false })
    h.stop(2) // and a different report (a later session sequence)
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(h.warnings.filter((text) => /gave up waiting for the key/.test(text))).toHaveLength(2)
    // Concurrent state publishes never left a temp file behind (unique, exclusive names).
    expect((await readdir(join(h.cwd, '.dsh/reports', 'kg1'))).filter((name) => name.includes('.tmp-'))).toEqual([])
  }, 20_000)
})
