import { describe, expect, it } from 'vitest'
import * as clientHost from '../src/client-host.js'
import * as gate from '../src/gate.js'
import * as report from '../src/report.js'
import * as runtime from '../src/index.js'

function mockContext() {
  const warnings: string[] = []
  return {
    warnings,
    ctx: {
      logger: { warn: (message: string) => warnings.push(message) },
    },
  }
}

describe('independent Cordis entries', () => {
  it('exports the runtime entry separately', () => {
    expect(runtime.name).toBe('dsh-viztools-runtime')
    expect(typeof runtime.apply).toBe('function')
  })

  it('exports a separate host roster entry for the Client bundle', () => {
    expect(clientHost.name).toBe('dsh-viztools-client-host')
    expect(typeof clientHost.apply).toBe('function')
  })

  it('loads the reserved gate entry inertly', () => {
    const { ctx, warnings } = mockContext()
    gate.apply(ctx as never, {
      planFirst: { enabled: false, planningTools: [], denialMessage: 'Plan not approved yet.' },
      runRules: { enabled: false, allowedTools: [], maxLimits: {} },
    })
    expect(gate.name).toBe('dsh-viztools-gate')
    expect(warnings).toEqual([])
  })

  it('loads the reserved report entry inertly', () => {
    const { ctx, warnings } = mockContext()
    report.apply(ctx as never, {
      enabled: false, cwd: '', triggerTools: [], triggerOnTurnStop: false, template: '', templateVersion: '1',
      outputDir: '.dsh/reports', includeCode: false, environmentDir: '.dsh/marimo', extraInputs: {},
    })
    expect(report.name).toBe('dsh-viztools-report')
    expect(warnings).toEqual([])
  })
})
