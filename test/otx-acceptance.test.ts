import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { Session } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { decideTool } from '../src/gate-policy.js'
import { foldGate, GATE_EVENT_TYPE } from '../src/gate-domain.js'
import { deploymentFingerprint, foldRunRules, RUN_RULES_EVENT, type RunRules } from '../src/run-rules.js'
import { matchTerminalResult } from '../src/report-trigger.js'
import { publishManagedState } from '../src/managed-state.js'
import { checkLockedProfile } from '../src/profile-check.js'
import { otxToolResultContentBlock } from './fixtures/otx-events.js'

const terminal = defineTool({
  name: 'mcp__otx__finalize_run', description: 'fixture', parameters: {},
  output: { schema: { type: 'object', additionalProperties: false, properties: { finalized: { type: 'boolean', required: true } } }, render: () => [{ type: 'text', text: 'finalized' }] },
  async execute() { return { finalized: true } },
})

describe('OTX acceptance chain', () => {
  it('enforces, replays, settles terminal evidence, publishes report state, and validates locked mode', async () => {
    const session = Session.create('otx-acceptance' as never)
    const planning = new Set(['run_code', 'exit_plan_mode', 'bench_status'])
    const deploymentAllowed = new Set(['run_code', 'exit_plan_mode', 'bench_status', 'mcp__otx__replay_tx_only', 'mcp__otx__finalize_run'])
    expect(decideTool({ knownAgent: true, planApproved: false, planningTools: planning, deploymentAllowed, deploymentLimits: {}, counts: {}, tool: 'mcp__otx__finalize_run' })?.code).toBe('PLAN_NOT_APPROVED')
    session.append(GATE_EVENT_TYPE, { kind: 'approved', version: 1, planCallId: 'plan' })
    expect(foldGate(session.snapshotEvents()).approved).toBe(true)

    const rules: RunRules = { version: 2, allow: ['mcp__otx__replay_tx_only', 'mcp__otx__finalize_run'], deny: [], limits: { mcp__otx__replay_tx_only: 1 }, notes: [], deploymentFingerprint: deploymentFingerprint([...deploymentAllowed], { mcp__otx__replay_tx_only: 1 }) }
    session.append(RUN_RULES_EVENT, { kind: 'approved', version: 2, callId: 'rules', rules })
    session.append(RUN_RULES_EVENT, { kind: 'accepted-call', version: 2, callId: 'replay-1', tool: 'mcp__otx__replay_tx_only' })
    const replayed = foldRunRules(session.snapshotEvents())
    expect(replayed.rules).toBeDefined()
    const activeRules = replayed.rules as RunRules
    expect(decideTool({ knownAgent: true, planApproved: true, planningTools: planning, deploymentAllowed, deploymentLimits: { mcp__otx__replay_tx_only: 1 }, rules: activeRules, counts: replayed.counts, tool: 'mcp__otx__replay_tx_only' })?.code).toBe('RUN_RULE_LIMIT')

    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {} as never).await()
    await ctx.plugin(ToolRuntime).await()
    ctx.tools.register(terminal)
    ctx.tools.guard((exec) => decideTool({ knownAgent: true, planApproved: true, planningTools: planning, deploymentAllowed, deploymentLimits: { mcp__otx__replay_tx_only: 1 }, rules: activeRules, counts: replayed.counts, tool: exec.name })?.reason)
    const result = await ctx.tools.execute({ callId: 'finalize-1' as never, name: 'mcp__otx__finalize_run', arguments: {}, signal: new AbortController().signal })
    expect(result.isError).toBe(false)

    const pending = new Map([['finalize-1', { callId: 'finalize-1', tool: 'mcp__otx__finalize_run' }]])
    expect(matchTerminalResult(otxToolResultContentBlock as never, pending)?.tool).toBe('mcp__otx__finalize_run')
    const root = await mkdtemp(join(tmpdir(), 'otx-acceptance-'))
    const statePath = await publishManagedState(root, { status: 'available', sessionId: 'otx-acceptance', html: '/report.html', updatedAt: 1 })
    expect(JSON.parse(await readFile(statePath, 'utf8')).status).toBe('available')

    expect(checkLockedProfile({
      mode: 'managed-readonly', cwd: '', notebook: '.dsh/reports/current/report.py', managedReportRoot: '.dsh/reports', environmentDir: '.dsh/marimo',
      uv: { command: 'uv', minVersion: '0.11.0', offline: true, indexUrl: '', findLinks: '', cacheDir: '.dsh/cache', pythonInstallDir: '.dsh/python', requirements: 'python/requirements.lock', requireHashes: true }, uvCommand: 'uv',
      pythonVersion: '3.12', marimoVersion: '0.25.1', mcpCodeMode: false, autoOpen: true, exportPath: '.dsh/report.html', startupTimeoutMs: 120000,
    })).toEqual({ ok: true, errors: [] })
  })
})
