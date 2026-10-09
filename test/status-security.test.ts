import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('model-facing status security', () => {
  it('does not expose browserUrl in the tool schema or result', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    const toolStart = source.indexOf("name: 'marimo_status'")
    const toolEnd = source.indexOf("name: 'marimo_export_html'")
    expect(toolStart).toBeGreaterThan(-1)
    expect(toolEnd).toBeGreaterThan(toolStart)
    expect(source.slice(toolStart, toolEnd)).not.toContain('browserUrl')
  })

  it('makes the managed notebook path authoritative in the model tool', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    expect(source).toContain('Always use this exact path for notebook edits')
  })

  it('keeps the secret URL in the authenticated Host RPC path', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    expect(source).toContain("path: '/api/viztools/sidebar-url'")
    expect(source).toContain('runtime.status().browserUrl')
  })
})
