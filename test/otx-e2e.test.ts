import { describe, expect, it } from 'vitest'
import { Session } from '@deepseek-ai/dsh-session'
import { foldGate, GATE_EVENT_TYPE } from '../src/gate-domain.js'
import { foldRunRules, RUN_RULES_EVENT, toolAllowed, type RunRules } from '../src/run-rules.js'
import { completedReportKeys, REPORT_EVENT, reportKey } from '../src/report-domain.js'
import { checkLockedProfile } from '../src/profile-check.js'

describe('OTX-like durable lifecycle', () => {
  it('replays plan approval, narrowing rules, terminal report, and locked runtime invariants', () => {
    const session = Session.create('otx-fixture' as never)
    expect(foldGate(session.snapshotEvents()).approved).toBe(false)

    session.append(GATE_EVENT_TYPE, { kind: 'refused', version: 1, callId: 'pre-1', tool: 'emit_otx', reason: 'Plan not approved yet.' })
    session.append(GATE_EVENT_TYPE, { kind: 'approved', version: 1, planCallId: 'plan-1' })
    expect(foldGate(session.snapshotEvents())).toMatchObject({ approved: true, refusals: 1 })

    const rules: RunRules = {
      version: 1,
      allow: ['mcp__otx__*'],
      deny: ['mcp__otx__emit_otx'],
      limits: { mcp__otx__replay_tx_only: 2 },
      notes: ['no edits after step 40'],
    }
    session.append(RUN_RULES_EVENT, { kind: 'approved', version: 1, callId: 'rules-1', rules })
    session.append('tool/call', { turn: 2, step: 1, callId: 'r1' as never, name: 'mcp__otx__replay_tx_only', arguments: '{}' })
    session.append('tool/call', { turn: 2, step: 1, callId: 'r2' as never, name: 'mcp__otx__replay_tx_only', arguments: '{}' })
    session.append(RUN_RULES_EVENT, { kind: 'limit-reached', version: 1, callId: 'r3', tool: 'mcp__otx__replay_tx_only', reason: 'limit', count: 2, limit: 2 })
    const ruleState = foldRunRules(session.snapshotEvents())
    expect(toolAllowed(rules, 'mcp__otx__diff')).toBe(true)
    expect(toolAllowed(rules, 'mcp__otx__emit_otx')).toBe(false)
    expect(ruleState.counts.mcp__otx__replay_tx_only).toBe(2)
    expect(ruleState.refusals).toHaveLength(1)

    session.append(REPORT_EVENT, {
      kind: 'available', version: 1, triggerSeq: 8, trigger: 'tool:mcp__otx__finalize_run', templateVersion: 'otx-v1',
      notebook: '.dsh/reports/otx-fixture/report.py', html: '.dsh/reports/otx-fixture/report.html', inputs: '.dsh/reports/otx-fixture/inputs.json',
    })
    expect(completedReportKeys(session.snapshotEvents(), 'otx-fixture').has(reportKey('otx-fixture', 8, 'otx-v1'))).toBe(true)

    expect(checkLockedProfile({
      mode: 'managed-readonly', cwd: '', notebook: '.dsh/reports/otx-fixture/report.py', managedReportRoot: '.dsh/reports',
      environmentDir: '.dsh/marimo', uvCommand: 'uv', uv: { command: 'uv', minVersion: '0.11.0', offline: true, indexUrl: '', findLinks: '', cacheDir: '.dsh/offline/cache', pythonInstallDir: '.dsh/offline/python', requirements: 'python/requirements.lock', requireHashes: true },
      pythonVersion: '3.12', marimoVersion: '0.25.1', mcpCodeMode: false, autoOpen: true,
      exportPath: '.dsh/reports/otx-fixture/report.html', startupTimeoutMs: 180000,
    })).toEqual({ ok: true, errors: [] })
  })
})
