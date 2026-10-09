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

  it('rejects unsafe session ids', () => {
    expect(() => managedStatePath('/reports', '../escape')).toThrow(/invalid/)
  })
})
