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
})
