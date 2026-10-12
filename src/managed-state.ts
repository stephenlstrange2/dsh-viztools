import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
/** Authenticated DSH route serving a finished report; exact path, session in the query. */
export const REPORT_ROUTE = '/api/viztools/report'

export function reportRouteUrl(sessionId: string): string {
  return `${REPORT_ROUTE}?session=${encodeURIComponent(sessionId)}`
}

export type ManagedReportState = {
  readonly status: 'pending'
  readonly sessionId: string
  readonly updatedAt: number
} | {
  readonly status: 'available'
  readonly sessionId: string
  /** Absolute filesystem path of the static export (host-side only). */
  readonly html: string
  /** Authenticated, origin-relative DSH route for the same export. */
  readonly url?: string
  readonly updatedAt: number
} | {
  readonly status: 'failed'
  readonly sessionId: string
  readonly reason: string
  readonly updatedAt: number
}

export function isSafeSessionId(sessionId: string): boolean {
  return SESSION_ID_PATTERN.test(sessionId) && !sessionId.includes('..')
}

export function managedStatePath(root: string, sessionId: string): string {
  if (!isSafeSessionId(sessionId)) throw new Error(`invalid managed report session id: ${sessionId}`)
  return join(root, sessionId, 'state.json')
}

/** Read the published state, or undefined when none exists yet. Malformed state is an error. */
export async function readManagedState(root: string, sessionId: string): Promise<ManagedReportState | undefined> {
  let text: string
  try {
    text = await readFile(managedStatePath(root, sessionId), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const value = JSON.parse(text) as ManagedReportState
  if (value.sessionId !== sessionId || !['pending', 'available', 'failed'].includes(value.status)) throw new Error(`malformed managed report state for ${sessionId}`)
  return value
}

export async function publishManagedState(root: string, state: ManagedReportState): Promise<string> {
  const target = managedStatePath(root, state.sessionId)
  await mkdir(dirname(target), { recursive: true })
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`
  await writeFile(temporary, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, target)
  return target
}
