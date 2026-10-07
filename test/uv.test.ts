import { describe, expect, it } from 'vitest'
import { parseUvVersion, versionAtLeast } from '../src/uv.js'

describe('uv requirement', () => {
  it('parses uv versions', () => {
    expect(parseUvVersion('uv 0.11.24 (x86_64-unknown-linux-gnu)')).toEqual({ major: 0, minor: 11, patch: 24 })
  })

  it('rejects unparseable output', () => {
    expect(() => parseUvVersion('not uv')).toThrow(/unable to parse/)
  })

  it('compares supported versions', () => {
    expect(versionAtLeast({ major: 0, minor: 11, patch: 24 }, { major: 0, minor: 11, patch: 0 })).toBe(true)
    expect(versionAtLeast({ major: 0, minor: 10, patch: 9 }, { major: 0, minor: 11, patch: 0 })).toBe(false)
  })
})
