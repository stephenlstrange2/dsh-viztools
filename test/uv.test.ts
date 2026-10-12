import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseUvVersion, probeUv, versionAtLeast } from '../src/uv.js'

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

  it.skipIf(process.platform === 'win32')('reads output that arrives after the process exits (exit/close race)', async () => {
    // The launcher exits immediately while a child it leaves behind writes the version later,
    // which is what an `exit`-based reader lost under load on a real console restart.
    const dir = await mkdtemp(join(tmpdir(), 'viztools-uv-'))
    const fake = join(dir, 'uv')
    await writeFile(fake, '#!/bin/sh\n(sleep 0.3; echo "uv 0.11.24 (fixture)") &\nexit 0\n')
    await chmod(fake, 0o755)
    await expect(probeUv(fake, '0.11.0', {})).resolves.toBeUndefined()
  })
})
