import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { checkLockedProfile } from '../src/profile-check.js'

const base = {
  mode: 'managed-readonly' as const,
  cwd: '', notebook: '.dsh/reports/current/report.py', managedReportRoot: '.dsh/reports', environmentDir: '.dsh/marimo', uvCommand: 'uv',
  uv: { command: 'uv', minVersion: '0.11.0', offline: false, indexUrl: '', findLinks: '', cacheDir: '', pythonInstallDir: '', requirements: 'python/requirements.lock', requireHashes: true },
  pythonVersion: '3.12', marimoVersion: '0.25.1', mcpCodeMode: false, autoOpen: true,
  exportPath: '.dsh/reports/current/report.html', startupTimeoutMs: 180_000,
}

describe('managed-readonly mode', () => {
  it('passes the exported locked-profile checker', () => {
    expect(checkLockedProfile(base)).toEqual({ ok: true, errors: [] })
  })

  it('rejects editable mode and requested MCP code mode', () => {
    const result = checkLockedProfile({ ...base, mode: 'editable', mcpCodeMode: true })
    expect(result.ok).toBe(false)
    expect(result.errors).toHaveLength(2)
  })

  it('rejects notebooks outside the managed report root', () => {
    const result = checkLockedProfile({ ...base, notebook: '.dsh/notebooks/freeform.py' })
    expect(result.ok).toBe(false)
    expect(result.errors).toContain('locked console notebook must be below managedReportRoot')
  })

  it('uses marimo run and omits code and tracebacks', () => {
    const source = readFileSync(new URL('../src/runtime.ts', import.meta.url), 'utf8')
    expect(source).toContain("readonly ? 'run' : 'edit'")
    expect(source).toContain("readonly ? ['--no-show-tracebacks']")
  })

  it('registers model tools and skills only in editable mode', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    expect(source).toContain("if (config.mode === 'editable')")
    expect(source).toContain("config.mode === 'editable' && status.mcpUrl")
  })
})
