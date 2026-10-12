import { readFile, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isSafeSessionId, readManagedState } from './managed-state.js'

/** Upper bound for one served export; marimo static exports are typically a few MB. */
export const MAX_REPORT_BYTES = 64 * 1024 * 1024

/**
 * Response headers for a served report. The export runs scripts, but it is served on the
 * authenticated DSH origin, so the CSP sandbox gives it an opaque origin: report scripts can
 * render but cannot read DSH cookies or call DSH APIs as the operator.
 */
export const REPORT_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': 'sandbox allow-scripts allow-popups allow-downloads',
}

function text(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
}

/**
 * Serve `<root>/<session>/report.html` after DSH has authenticated the request.
 * Only an `available` published state is served, and only when its export resolves to
 * exactly that session's `report.html` inside the managed root (no symlink escapes).
 */
export async function serveReport(root: string, request: Request): Promise<Response> {
  const sessionId = new URL(request.url).searchParams.get('session') ?? ''
  if (!isSafeSessionId(sessionId)) return text(400, 'invalid session id')
  let state
  try {
    state = await readManagedState(root, sessionId)
  } catch {
    return text(500, 'report state is unreadable')
  }
  if (state === undefined || state.status === 'pending') return text(404, 'report not available yet')
  if (state.status === 'failed') return text(409, 'report generation failed')
  let target: string
  try {
    const sessionDir = await realpath(join(await realpath(root), sessionId))
    target = await realpath(state.html)
    if (target !== join(sessionDir, 'report.html')) return text(403, 'report path is outside the managed report root')
    if ((await stat(target)).size > MAX_REPORT_BYTES) return text(413, 'report is too large to serve')
  } catch {
    return text(404, 'report file is missing')
  }
  const body = await readFile(target)
  return new Response(request.method === 'HEAD' ? null : body, { status: 200, headers: REPORT_HEADERS })
}
