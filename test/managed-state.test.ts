import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { managedStatePath, publishManagedState } from '../src/managed-state.js'

describe('stable managed report state', () => {
  it('publishes pending then available state atomically for one session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'viztools-state-'))
    const target = await publishManagedState(root, { status: 'pending', sessionId: 'session-1', updatedAt: 1 })
    expect(target).toBe(managedStatePath(root, 'session-1'))
    expect(JSON.parse(await readFile(target, 'utf8')).status).toBe('pending')
    await publishManagedState(root, { status: 'available', sessionId: 'session-1', html: '/reports/session-1/report.html', updatedAt: 2 })
    expect(JSON.parse(await readFile(target, 'utf8'))).toMatchObject({ status: 'available', html: '/reports/session-1/report.html' })
  })

  it('publishes concurrently without temp-name collisions (race-safe rename)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'viztools-state-'))
    const { readdir } = await import('node:fs/promises')
    await Promise.all(Array.from({ length: 40 }, (_, index) => publishManagedState(root, { status: 'pending', sessionId: 'race', updatedAt: index })))
    expect(JSON.parse(await readFile(managedStatePath(root, 'race'), 'utf8')).status).toBe('pending')
    expect((await readdir(join(root, 'race'))).filter((name) => name !== 'state.json')).toEqual([])
  })

  it('rejects unsafe session ids', () => {
    expect(() => managedStatePath('/reports', '../escape')).toThrow(/invalid/)
  })
})
