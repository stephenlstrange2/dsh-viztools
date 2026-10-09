import { describe, expect, it } from 'vitest'
import { runReportCommand } from '../src/report.js'

describe('report export timeout', () => {
  it('terminates a hung subprocess within the timeout budget', async () => {
    const started = Date.now()
    await expect(runReportCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], process.cwd(), {}, 1000, 100)).rejects.toThrow(/timed out/)
    expect(Date.now() - started).toBeLessThan(5000)
  }, 10_000)
})
