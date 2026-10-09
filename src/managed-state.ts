import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export type ManagedReportState = {
  readonly status: 'pending'
  readonly sessionId: string
  readonly updatedAt: number
} | {
  readonly status: 'available'
  readonly sessionId: string
  readonly html: string
  readonly updatedAt: number
} | {
  readonly status: 'failed'
  readonly sessionId: string
  readonly reason: string
  readonly updatedAt: number
}

export function managedStatePath(root: string, sessionId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sessionId)) throw new Error(`invalid managed report session id: ${sessionId}`)
  return join(root, sessionId, 'state.json')
}

export async function publishManagedState(root: string, state: ManagedReportState): Promise<string> {
  const target = managedStatePath(root, state.sessionId)
  await mkdir(dirname(target), { recursive: true })
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`
  await writeFile(temporary, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, target)
  return target
}
