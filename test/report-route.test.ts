import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { publishManagedState, reportRouteUrl } from '../src/managed-state.js'
import { serveReport } from '../src/report-route.js'

const get = (root: string, session: string) => serveReport(root, new Request(`http://127.0.0.1:3185${reportRouteUrl(session)}`))

describe('authenticated report route', () => {
  it('serves an available contained export with an opaque-origin sandbox', async () => {
    const root = await mkdtemp(join(tmpdir(), 'viztools-route-'))
    await mkdir(join(root, 's1'))
    await writeFile(join(root, 's1', 'report.html'), '<html><body>report</body></html>')
    await publishManagedState(root, { status: 'available', sessionId: 's1', html: join(root, 's1', 'report.html'), url: reportRouteUrl('s1'), updatedAt: 1 })
    const response = await get(root, 's1')
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('report')
    expect(response.headers.get('content-security-policy')).toMatch(/^sandbox allow-scripts/)
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('rejects traversal ids, pending, failed, and missing reports', async () => {
    const root = await mkdtemp(join(tmpdir(), 'viztools-route-'))
    expect((await serveReport(root, new Request('http://x/api/viztools/report?session=..%2Fetc'))).status).toBe(400)
    expect((await serveReport(root, new Request('http://x/api/viztools/report'))).status).toBe(400)
    expect((await get(root, 'none')).status).toBe(404)
    await publishManagedState(root, { status: 'pending', sessionId: 'p', updatedAt: 1 })
    expect((await get(root, 'p')).status).toBe(404)
    await publishManagedState(root, { status: 'failed', sessionId: 'f', reason: 'x', updatedAt: 1 })
    expect((await get(root, 'f')).status).toBe(409)
  })

  it('refuses exports that resolve outside the session directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'viztools-route-'))
    const outside = await mkdtemp(join(tmpdir(), 'viztools-outside-'))
    await writeFile(join(outside, 'report.html'), 'secret')
    await publishManagedState(root, { status: 'available', sessionId: 'a', html: join(outside, 'report.html'), updatedAt: 1 })
    expect((await get(root, 'a')).status).toBe(403)
    await mkdir(join(root, 'b'))
    await symlink(join(outside, 'report.html'), join(root, 'b', 'report.html'))
    await publishManagedState(root, { status: 'available', sessionId: 'b', html: join(root, 'b', 'report.html'), updatedAt: 1 })
    const response = await get(root, 'b')
    expect(response.status).toBe(403)
    expect(await response.text()).not.toContain('secret')
  })
})
