import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Never let tests create a dsh-viztools key or anchors in the developer's real DSH home.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'viztools-dsh-home-'))
