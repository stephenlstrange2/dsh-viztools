import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('default report privacy', () => {
  it('uses safe projected tool rows instead of raw tool_calls', () => {
    const source = readFileSync(new URL('../python/dsh_viztools/report_template.py', import.meta.url), 'utf8')
    expect(source).toContain('safe_tool_rows(run.tool_calls)')
    expect(source).not.toContain('mo.ui.table(run.tool_calls')
  })
})
