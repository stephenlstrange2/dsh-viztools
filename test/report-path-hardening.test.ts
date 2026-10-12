import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { managedStatePath } from '../src/managed-state.js'

describe('report path hardening', () => {
  it('rejects unsafe session directory identities', () => {
    expect(() => managedStatePath('/reports', '../escape')).toThrow(/invalid/)
    expect(() => managedStatePath('/reports', 'a/b')).toThrow(/invalid/)
  })

  it('realpath-checks trusted templates before copy', () => {
    const source = readFileSync(new URL('../src/report.ts', import.meta.url), 'utf8')
    expect(source).toContain("containedExistingPath(cwd, config.template, 'report template')")
    expect(source).toContain('safeSessionId(String(agent.id))')
  })
})
