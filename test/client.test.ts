import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseSidebarStatus } from '../src/client.js'

describe('secure sidebar payload', () => {
  it('accepts only the complete Host response', () => {
    expect(parseSidebarStatus({
      browserUrl: 'http://127.0.0.1:4321/?access_token=secret',
      notebook: '/workspace/.dsh/notebooks/explanation.py',
      marimoVersion: '0.25.1',
      processStartedAt: 123,
    })).toEqual({
      browserUrl: 'http://127.0.0.1:4321/?access_token=secret',
      notebook: '/workspace/.dsh/notebooks/explanation.py',
      marimoVersion: '0.25.1',
      processStartedAt: 123,
    })
  })

  it('rejects incomplete or malformed responses', () => {
    expect(parseSidebarStatus({ browserUrl: 'x' })).toBeUndefined()
    expect(parseSidebarStatus(null)).toBeUndefined()
  })

  it('uses an origin-absolute authenticated route and waits for Browser registration', () => {
    const source = readFileSync(new URL('../src/client.ts', import.meta.url), 'utf8')
    expect(source).toContain("fetch('/api/viztools/sidebar-url'")
    expect(source).toContain("sidebarRightTabs.get('browser')")
  })
})
