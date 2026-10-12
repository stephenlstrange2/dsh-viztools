import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('runtime secret and lock hardening', () => {
  const source = readFileSync(new URL('../src/runtime.ts', import.meta.url), 'utf8')

  it('passes a token file path instead of the secret on argv', () => {
    expect(source).toContain("'--token-password-file', tokenFile")
    expect(source).not.toContain("'--token-password', token")
    expect(source).toContain('mode: 0o600')
  })

  it('removes token files during child exit and stop', () => {
    expect(source).toContain("rm(this.tokenFile, { force: true })")
  })

  it('hashes requirements contents into the environment marker', () => {
    expect(source).toContain("createHash('sha256').update(await readFile(requirements)).digest('hex')")
    expect(source).toContain('requirementsHash')
  })
})
