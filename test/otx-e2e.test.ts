import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Session } from '@deepseek-ai/dsh-session'
import { evaluateTrust, foldGateRecords } from '../src/gate-state.js'
import { deploymentFingerprint, type RunRules } from '../src/run-rules.js'
import { completedReportKeysFromRecords, reportKey } from '../src/report-domain.js'
import { createSidecarStore } from '../src/state-store.js'
import { checkLockedProfile } from '../src/profile-check.js'

describe('OTX-like durable lifecycle on the plugin store', () => {
  it('replays plan approval, narrowing rules, counts, refusals, and the terminal report without touching the session log', async () => {
    const root = await mkdtemp(join(tmpdir(), 'viztools-e2e-'))
    const session = Session.create('otx-fixture' as never)
    const gate = createSidecarStore(root, session as never, 'gate')
    const report = createSidecarStore(root, session as never, 'report')
    gate.append('refused', { callId: 'pre-1', tool: 'mcp__otx__emit_otx', code: 'PLAN_NOT_APPROVED', reason: 'Plan not approved yet.', beforeApproval: true })
    gate.append('plan-approved', { planCallId: 'plan-1' })
    const rules: RunRules = {
      version: 3, allow: ['mcp__otx__diff', 'mcp__otx__replay_tx_only'], deny: ['mcp__otx__emit_otx'], limits: { mcp__otx__replay_tx_only: 2 }, notes: ['no edits after step 40'],
      deploymentFingerprint: deploymentFingerprint(['mcp__otx__diff', 'mcp__otx__emit_otx', 'mcp__otx__replay_tx_only'], { mcp__otx__replay_tx_only: 2 }),
    }
    gate.append('rules-approved', { callId: 'rules-1', rules: rules as never })
    gate.append('started', { callId: 'r1', tool: 'mcp__otx__replay_tx_only' })
    gate.append('started', { callId: 'r2', tool: 'mcp__otx__replay_tx_only' })
    gate.append('refused', { callId: 'r3', tool: 'mcp__otx__replay_tx_only', code: 'RUN_RULE_LIMIT', reason: 'limit', count: 2, limit: 2, beforeApproval: false })
    report.append('available', { version: 1, triggerSeq: 8, trigger: 'tool:mcp__otx__finalize_run', templateVersion: 'otx-v1', notebook: 'n', html: 'h', inputs: 'i' })

    const snapshot = createSidecarStore(root, session as never, 'gate').read()
    const fold = foldGateRecords(snapshot.records)
    expect(fold).toMatchObject({ approved: true, counts: { mcp__otx__replay_tx_only: 2 } })
    expect(fold.refusals.map((refusal) => [refusal.code, refusal.beforeApproval])).toEqual([['PLAN_NOT_APPROVED', true], ['RUN_RULE_LIMIT', false]])
    expect(evaluateTrust(session.snapshotEvents(), snapshot, fold, new Set(['mcp__otx__replay_tx_only'])).countsTrusted).toBe(true)
    expect(completedReportKeysFromRecords(createSidecarStore(root, session as never, 'report').read().records, 'otx-fixture').has(reportKey('otx-fixture', 8, 'otx-v1'))).toBe(true)
    expect(session.snapshotEvents()).toEqual([])

    expect(checkLockedProfile({
      mode: 'managed-readonly', cwd: '', notebook: '.dsh/reports/otx-fixture/report.py', managedReportRoot: '.dsh/reports', gateStateDir: '.dsh/viztools/state',
      environmentDir: '.dsh/marimo', uvCommand: 'uv', uv: { command: 'uv', minVersion: '0.11.0', offline: true, indexUrl: '', findLinks: '', cacheDir: '.dsh/offline/cache', pythonInstallDir: '.dsh/offline/python', requirements: 'python/requirements.lock', requireHashes: true },
      pythonVersion: '3.12', marimoVersion: '0.25.1', mcpCodeMode: false, autoOpen: true,
      exportPath: '.dsh/reports/otx-fixture/report.html', startupTimeoutMs: 180000,
    })).toEqual({ ok: true, errors: [] })
  })
})
