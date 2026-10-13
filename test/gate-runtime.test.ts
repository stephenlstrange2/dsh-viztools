import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { Session } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import * as gate from '../src/gate.js'
import type { GateInput } from '../src/gate.js'
import type { PluginRecordApi } from '../src/state-store.js'

const ok = (name: string, body: () => unknown = () => ({ ok: true })) => defineTool({
  name, description: `fixture ${name}`, parameters: {},
  output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: () => [{ type: 'text', text: name }] },
  async execute() { return body() as never },
})

interface Harness {
  ctx: Context
  root: string
  agent: (id: string, session?: Session) => Promise<{ id: string; session: Session; ctx: Context }>
  call: (agent: { id: string; session: Session; ctx: Context }, name: string, callId: string, signal?: AbortSignal) => Promise<{ isError: boolean; text: string; code?: string }>
  ran: string[]
}

async function harness(config: GateInput, options: { planMode?: boolean; tools?: string[]; pluginRecords?: PluginRecordApi | null; root?: string; sandboxPolicy?: Record<string, unknown>; confinedReads?: boolean } = {}): Promise<Harness> {
  const root = options.root ?? await mkdtemp(join(tmpdir(), 'viztools-gate-'))
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {} as never).await()
  await ctx.plugin(ToolRuntime).await()
  ctx.provide('userQuestions', { ask: async (request: { questions: { id: string }[] }) => ({ answers: request.questions.map((q) => ({ id: q.id, selected: ['Approve'] })) }) } as never)
  if (options.planMode !== false) ctx.provide('planMode', { set: () => 'committed' } as never)
  if (options.sandboxPolicy !== undefined) ctx.provide('sandboxPolicy', options.sandboxPolicy as never)
  if (options.confinedReads === true) {
    // A read-confining sandbox: confined processes cannot read anything under the DSH home.
    const home = process.env.DSH_HOME as string
    ctx.provide('sandbox', { confine: async (argv: readonly string[]) => ({ argv: argv.some((arg) => arg.startsWith(home)) ? ['false'] : [...argv] }) } as never)
  }
  const ran: string[] = []
  for (const name of options.tools ?? ['bench_status', 'replay', 'diff', 'subagent']) ctx.tools.register(ok(name, () => { ran.push(name); return { ok: true } }))
  ctx.tools.register(ok('exit_plan_mode', () => ({ approved: true })))
  await ctx.plugin({ name: 'gate', inject: gate.inject, apply: (inner: Context, cfg: GateInput) => gate.apply(inner, cfg, { pluginRecords: options.pluginRecords ?? null }) } as never, { cwd: root, ...config } as never).await()
  return {
    ctx, root, ran,
    async agent(id, session = Session.create(id as never)) {
      // Thin per-agent context: guards/listeners go to the shared runtime, prompt sections are per agent.
      const agentCtx = {
        tools: ctx.tools,
        on: ctx.on.bind(ctx),
        get: ctx.get.bind(ctx),
        effect: (fn: () => unknown) => fn(),
        systemPrompt: { section: () => () => undefined },
      }
      const agent = { id, session, ctx: agentCtx as unknown as Context }
      await (ctx as unknown as { parallel: (...args: unknown[]) => Promise<void> }).parallel('agent/created', { agent })
      return agent
    },
    async call(agent, name, callId, signal = new AbortController().signal) {
      const result = await ctx.tools.execute({ callId: callId as never, name, arguments: {}, agent: agent as never, signal })
      const text = result.content.map((block) => (block as { text?: string }).text ?? '').join('')
      const code = (result as { error?: { info?: { code?: string } } }).error?.info?.code
      return { isError: result.isError, text, ...(code === undefined ? {} : { code }) }
    },
  }
}

function setSandbox(agent: { session: Session }, mode: string): void {
  (agent.session as unknown as { append(type: string, data: unknown): void }).append('sandbox/mode', { mode })
}

const otx = (extra: Partial<GateInput> = {}): GateInput => ({
  planFirst: { enabled: true, planningTools: ['bench_status'] },
  runRules: { enabled: true, allowedTools: ['bench_status', 'replay', 'diff'], maxLimits: { replay: 2 } },
  ...extra,
})

async function sidecar(root: string, session: string): Promise<{ kind: string; data: Record<string, unknown> }[]> {
  const path = join(root, '.dsh/viztools/state', `${session}.gate.jsonl`)
  if (!existsSync(path)) return []
  return (await readFile(path, 'utf8')).split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)] } catch { return [] } })
}

describe('gate durable state (sidecar on DSH rc.2)', () => {
  it('writes no custom event types into the session log and keeps everything in the sidecar', async () => {
    const h = await harness(otx())
    const agent = await h.agent('s1')
    expect((await h.call(agent, 'replay', 'c1')).isError).toBe(true)
    await h.call(agent, 'exit_plan_mode', 'plan')
    expect((await h.call(agent, 'replay', 'c2')).isError).toBe(false)
    expect(agent.session.snapshotEvents().some((event) => String(event.type).startsWith('viztools'))).toBe(false)
    const kinds = (await sidecar(h.root, 's1')).map((record) => record.kind)
    expect(kinds).toEqual(['refused', 'plan-approved', 'started'])
  })

  it('replays the same approval and counts after a restart (live == replay)', async () => {
    const h = await harness(otx())
    const agent = await h.agent('s2')
    await h.call(agent, 'exit_plan_mode', 'plan')
    await h.call(agent, 'replay', 'r1')
    await h.call(agent, 'replay', 'r2')
    expect((await h.call(agent, 'replay', 'r3')).text).toMatch(/limit reached/)
    // Restart: a fresh plugin instance over the same workspace and the same session log.
    const restarted = await harness(otx(), { root: h.root })
    const resumed = await restarted.agent('s2', Session.create('s2' as never, agent.session.snapshotEvents()))
    expect((await restarted.call(resumed, 'diff', 'd1')).isError).toBe(false)
    expect((await restarted.call(resumed, 'replay', 'r4')).text).toMatch(/limit reached/)
    expect(restarted.ran).toEqual(['diff'])
  })

  it('fails closed when the sidecar is truncated: no approval, limited tools refused', async () => {
    const h = await harness(otx())
    const agent = await h.agent('s3')
    await h.call(agent, 'exit_plan_mode', 'plan')
    await h.call(agent, 'replay', 'r1')
    const path = join(h.root, '.dsh/viztools/state', 's3.gate.jsonl')
    const text = await readFile(path, 'utf8')
    await writeFile(path, text.slice(0, text.length - 12))
    const restarted = await harness(otx(), { root: h.root })
    const resumed = await restarted.agent('s3', Session.create('s3' as never, agent.session.snapshotEvents()))
    const diff = await restarted.call(resumed, 'diff', 'd1')
    expect(diff.text).toMatch(/Plan not approved yet\..*truncated/)
    await restarted.call(resumed, 'exit_plan_mode', 'plan-again')
    // Re-approval restores the plan, but rules stay refused and counts stay untrusted.
    expect((await restarted.call(resumed, 'diff', 'd2')).text).toMatch(/every governed tool is refused/)
    expect(restarted.ran).toEqual([])
    const kinds = (await sidecar(h.root, 's3')).map((record) => record.kind)
    expect(kinds).toContain('reset')
  })

  it('fails closed when a mid-file record was deleted (hash chain)', async () => {
    const h = await harness(otx())
    const agent = await h.agent('s4')
    await h.call(agent, 'replay', 'pre')
    await h.call(agent, 'exit_plan_mode', 'plan')
    await h.call(agent, 'replay', 'r1')
    const path = join(h.root, '.dsh/viztools/state', 's4.gate.jsonl')
    const lines = (await readFile(path, 'utf8')).split('\n').filter(Boolean)
    await writeFile(path, `${[lines[0], lines[2]].join('\n')}\n`)
    const restarted = await harness(otx(), { root: h.root })
    const resumed = await restarted.agent('s4', Session.create('s4' as never, agent.session.snapshotEvents()))
    expect((await restarted.call(resumed, 'diff', 'd1')).text).toMatch(/Plan not approved yet/)
  })

  it('opens sessions whose sidecar is missing but refuses limited tools when evidence of gated activity exists', async () => {
    const h = await harness({ planFirst: { enabled: false }, runRules: { enabled: true, allowedTools: ['replay', 'diff'], maxLimits: { replay: 5 } } })
    const agent = await h.agent('s5')
    await h.call(agent, 'replay', 'r1')
    await rm(join(h.root, '.dsh/viztools/state'), { recursive: true })
    // The session log still proves a completed replay; the store that counted it is gone.
    const events = [
      ...agent.session.snapshotEvents(),
      { type: 'tool/call', seq: agent.session.snapshotEvents().length, time: 1, data: { turn: 1, step: 1, callId: 'r1', name: 'replay', arguments: '{}' } },
      { type: 'tool/result', seq: agent.session.snapshotEvents().length + 1, time: 2, data: { turn: 1, step: 1, message: { role: 'tool', source: { kind: 'tool', callId: 'r1' }, content: [{ type: 'tool-result', toolCallId: 'r1', isError: false, content: [{ type: 'text', text: '{}' }] }] } } },
    ]
    const restarted = await harness({ planFirst: { enabled: false }, runRules: { enabled: true, allowedTools: ['replay', 'diff'], maxLimits: { replay: 5 } } }, { root: h.root })
    const resumed = await restarted.agent('s5', { snapshotEvents: () => events, header: {}, inheritedEventCount: 0, seq: events.length, id: 's5' } as never)
    expect((await restarted.call(resumed, 'replay', 'r2')).text).toMatch(/count can no longer be trusted|every governed tool is refused/)
  })
})

describe('keyed chain and out-of-workspace anchor (item 1, PoCs)', () => {
  it('a forged plan approval appended from the workspace is rejected', async () => {
    const h = await harness(otx())
    const agent = await h.agent('k1')
    expect((await h.call(agent, 'diff', 'd0')).isError).toBe(true)
    const path = join(h.root, '.dsh/viztools/state', 'k1.gate.jsonl')
    const last = (await sidecar(h.root, 'k1')).at(-1) as unknown as { i: number; mac: string }
    const { createHash } = await import('node:crypto')
    const forged = { i: last.i + 1, prev: last.mac, t: Date.now(), logSeq: 0, kind: 'plan-approved', data: { planCallId: 'forged' }, session: 'k1' }
    await writeFile(path, `${await readFile(path, 'utf8')}${JSON.stringify({ ...forged, mac: createHash('sha256').update(JSON.stringify(forged)).digest('hex') })}\n`)
    const restarted = await harness(otx(), { root: h.root })
    const resumed = await restarted.agent('k1', Session.create('k1' as never, agent.session.snapshotEvents()))
    expect((await restarted.call(resumed, 'diff', 'd1')).text).toMatch(/Plan not approved yet\..*fails authentication/)
  })

  it('truncating the last started record from the workspace keeps limited tools refused', async () => {
    const h = await harness(otx())
    const agent = await h.agent('k2')
    await h.call(agent, 'exit_plan_mode', 'plan')
    await h.call(agent, 'replay', 'r1')
    await h.call(agent, 'replay', 'r2')
    const path = join(h.root, '.dsh/viztools/state', 'k2.gate.jsonl')
    const lines = (await readFile(path, 'utf8')).trim().split('\n')
    // PoC: drop the last whole record so a replay slot appears free; the chain stays consistent.
    await writeFile(path, `${lines.slice(0, -1).join('\n')}\n`)
    const restarted = await harness(otx(), { root: h.root })
    const resumed = await restarted.agent('k2', Session.create('k2' as never, agent.session.snapshotEvents()))
    expect((await restarted.call(resumed, 'replay', 'r3')).isError).toBe(true)
    expect(restarted.ran).toEqual([])
  })

  it('a key directory inside the workspace (also via a symlink) denies all with a notice instead of throwing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'viztools-gate-'))
    const h = await harness({ ...otx(), keyDir: join(root, '.keys') }, { root })
    const agent = await h.agent('kd1')
    expect((await h.call(agent, 'bench_status', 'b')).text).toMatch(/cannot use its key directory.*outside the workspace.*Every tool is refused/)
    const { symlink } = await import('node:fs/promises')
    const outside = await mkdtemp(join(tmpdir(), 'viztools-outside-'))
    await symlink(root, join(outside, 'ws-link'))
    // keyDir looks outside, but realpath puts it inside the workspace.
    const linked = await harness({ ...otx(), keyDir: join(outside, 'ws-link', 'keys') }, { root })
    expect((await linked.call(await linked.agent('kd2'), 'bench_status', 'b')).text).toMatch(/outside the workspace/)
  })

  it('a key directory or key file with group/other access denies all with a notice', async () => {
    const { chmod, mkdir } = await import('node:fs/promises')
    const keyDir = await mkdtemp(join(tmpdir(), 'viztools-keys-'))
    await chmod(keyDir, 0o755)
    const h = await harness({ ...otx(), keyDir })
    expect((await h.call(await h.agent('kp1'), 'bench_status', 'b')).text).toMatch(/must not be accessible to group or others/)
    const keyDir2 = join(await mkdtemp(join(tmpdir(), 'viztools-keys-')), 'k')
    await mkdir(keyDir2, { mode: 0o700 })
    await writeFile(join(keyDir2, 'sidecar.key'), 'a'.repeat(64), { mode: 0o644 })
    const h2 = await harness({ ...otx(), keyDir: keyDir2 })
    expect((await h2.call(await h2.agent('kp2'), 'bench_status', 'b')).text).toMatch(/must not be accessible to group or others/)
  })
})

describe('key readable by tool subprocesses (item 2)', () => {
  const readers = (extra: Partial<GateInput> = {}): GateInput => ({ planFirst: { enabled: false }, runRules: { enabled: true, allowedTools: ['bash', 'replay'], maxLimits: { replay: 2 } }, ...extra })

  it('denies every tool when a file-reading tool is allowed and no sandbox proves the key unreadable', async () => {
    const h = await harness(readers(), { tools: ['bash', 'replay'] })
    const agent = await h.agent('r1')
    for (const tool of ['replay', 'bash']) expect((await h.call(agent, tool, `c-${tool}`)).text).toMatch(/tamper-evident only against agents that cannot read .*bash can read files/)
    expect(h.ran).toEqual([])
  })

  it('allows the deployment when DSH\'s sandbox demonstrably denies reads of the key directory', async () => {
    const h = await harness(readers(), { tools: ['bash', 'replay'], confinedReads: true, sandboxPolicy: { defaultMode: 'workspace-write' } })
    const agent = await h.agent('r2')
    expect((await h.call(agent, 'replay', 'c')).isError).toBe(false)
  })

  it('a sandbox that confines nothing fails the probe (control readable, key readable)', async () => {
    const h = await harness(readers(), { tools: ['bash', 'replay'], sandboxPolicy: { defaultMode: 'workspace-write' } })
    h.ctx.provide('sandbox', { confine: async (argv: readonly string[]) => ({ argv: [...argv] }) } as never)
    const agent = await h.agent('r3')
    expect((await h.call(agent, 'replay', 'c')).text).toMatch(/tamper-evident only/)
  })

  it('treats the deployment\'s own reader list as authoritative (MCP readers)', async () => {
    const h = await harness({ ...readers(), runRules: { enabled: true, allowedTools: ['replay', 'diff'], maxLimits: { replay: 2 } }, keyProtection: { fileReadingTools: ['diff'] } })
    expect((await h.call(await h.agent('r4'), 'replay', 'c')).text).toMatch(/diff can read files/)
  })

  it('does not interfere when no file-reading tool is allowed (the OTX console)', async () => {
    const h = await harness(otx())
    const agent = await h.agent('r5')
    expect((await h.call(agent, 'bench_status', 'b')).isError).toBe(false)
  })
})

describe('session and channel binding (item 1, PoCs)', () => {
  it('records copied from another session\'s sidecar fail authentication', async () => {
    const h = await harness(otx())
    const victim = await h.agent('b-victim')
    const donor = await h.agent('b-donor')
    await h.call(donor, 'exit_plan_mode', 'plan')
    const dir = join(h.root, '.dsh/viztools/state')
    // PoC: graft the donor's approval (MAC-valid for the donor) onto the victim's chain.
    const victimLines = (await readFile(join(dir, 'b-victim.gate.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean)
    const donorApproval = (await readFile(join(dir, 'b-donor.gate.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line)).find((record: { kind: string }) => record.kind === 'plan-approved')
    const last = victimLines.length === 0 ? undefined : JSON.parse(victimLines.at(-1) as string)
    const grafted = { ...donorApproval, i: last === undefined ? 0 : last.i + 1, prev: last?.mac ?? '' }
    await writeFile(join(dir, 'b-victim.gate.jsonl'), `${[...victimLines, JSON.stringify(grafted)].join('\n')}\n`)
    const restarted = await harness(otx(), { root: h.root })
    const resumed = await restarted.agent('b-victim', Session.create('b-victim' as never, victim.session.snapshotEvents()))
    expect((await restarted.call(resumed, 'diff', 'd')).text).toMatch(/Plan not approved yet/)
  })

  it('after a reset, truncating a later narrowing rules approval is detected and voids approval and rules again', async () => {
    const config: GateInput = { planFirst: { enabled: false }, runRules: { enabled: true, allowedTools: ['replay', 'diff'], maxLimits: { replay: 2 } } }
    const h = await harness(config)
    const agent = await h.agent('t1')
    await h.call(agent, 'replay', 'r0')
    const dir = join(h.root, '.dsh/viztools/state')
    // Damage the chain so the next open writes a reset.
    const original = (await readFile(join(dir, 't1.gate.jsonl'), 'utf8')).trim().split('\n')
    await writeFile(join(dir, 't1.gate.jsonl'), `${original.slice(0, -1).join('\n')}\n`)
    const second = await harness(config, { root: h.root })
    const resumed = await second.agent('t1', Session.create('t1' as never, agent.session.snapshotEvents()))
    const propose = (callId: string, deny: string[]) => second.ctx.tools.execute({ callId: callId as never, name: 'propose_run_rules', arguments: { deny, limits: {}, notes: [] }, agent: resumed as never, signal: new AbortController().signal })
    expect((await propose('broad', [])).isError).toBe(false)
    expect((await propose('narrow', ['diff'])).isError).toBe(false)
    expect((await second.call(resumed, 'diff', 'd1')).text).toMatch(/Approved run rules deny tool diff/)
    // PoC: drop the narrowing approval (the last record) from the post-reset tail.
    const lines = (await readFile(join(dir, 't1.gate.jsonl'), 'utf8')).trim().split('\n')
    await writeFile(join(dir, 't1.gate.jsonl'), `${lines.slice(0, -1).join('\n')}\n`)
    const third = await harness(config, { root: h.root })
    const again = await third.agent('t1', Session.create('t1' as never, agent.session.snapshotEvents()))
    expect((await third.call(again, 'diff', 'd2')).text).toMatch(/every governed tool is refused|Approved run rules deny/)
    expect(third.ran).toEqual([])
  })
})

describe('run_code is governed (fix 3)', () => {
  it('is refused before approval by default, even though it is the PTC transport', async () => {
    const h = await harness(otx())
    const agent = await h.agent('p1')
    setSandbox(agent, 'workspace-write')
    expect((await h.call(agent, 'run_code', 'c')).text).toMatch(/run_code is refused before plan approval/)
  })

  it('opt-in allows it only under a confined file policy', async () => {
    const h = await harness(otx({ planFirst: { enabled: true, planningTools: ['bench_status'], allowPtcTransport: true }, runRules: { enabled: true, allowedTools: ['bench_status', 'replay', 'diff', 'run_code'], maxLimits: { replay: 2 } } }), { confinedReads: true })
    const confined = await h.agent('p2')
    setSandbox(confined, 'workspace-write')
    const allowed = await h.call(confined, 'run_code', 'c1')
    // The gate lets it through; native presentation then has no transport to dispatch.
    expect(allowed.text).not.toMatch(/refused|denies|not approved/)
    const open = await h.agent('p3')
    setSandbox(open, 'danger-full-access')
    // Under full access the key is readable, so with a file reader allowed everything is refused.
    expect((await h.call(open, 'run_code', 'c2')).text).toMatch(/tamper-evident only against agents that cannot read/)
    const unknown = await h.agent('p4')
    // An unknown file policy cannot prove the key unreadable either.
    expect((await h.call(unknown, 'run_code', 'c3')).text).toMatch(/tamper-evident only against agents that cannot read/)
  })

  it('after approval it is subject to the deployment allowlist like any tool', async () => {
    const h = await harness(otx())
    const agent = await h.agent('p5')
    await h.call(agent, 'exit_plan_mode', 'plan')
    expect((await h.call(agent, 'run_code', 'c')).text).toMatch(/Deployment policy denies tool run_code/)
  })
})

describe('run_code before approval also honours the allowlist, invalid rules, and the deployment default mode', () => {
  const ptc = (extra: Partial<GateInput> = {}) => otx({ planFirst: { enabled: true, planningTools: ['bench_status'], allowPtcTransport: true }, ...extra })

  it('is refused before approval when run_code is not in allowedTools, even with the opt-in and a confined policy', async () => {
    const h = await harness(ptc(), { confinedReads: true })
    const agent = await h.agent('q1')
    setSandbox(agent, 'workspace-write')
    expect((await h.call(agent, 'run_code', 'c')).text).toMatch(/Deployment policy denies tool run_code/)
  })

  it('is refused before approval while saved rules are invalid', async () => {
    const config = ptc({ runRules: { enabled: true, allowedTools: ['bench_status', 'replay', 'run_code'], maxLimits: { replay: 2 } } })
    const h = await harness(config, { confinedReads: true })
    const agent = await h.agent('q2')
    setSandbox(agent, 'workspace-write')
    await h.ctx.tools.execute({ callId: 'rules' as never, name: 'propose_run_rules', arguments: { deny: [], limits: { replay: 2 }, notes: [] }, agent: agent as never, signal: new AbortController().signal })
    const stricter = await harness({ ...config, runRules: { enabled: true, allowedTools: ['bench_status', 'replay', 'run_code'], maxLimits: { replay: 1 } } }, { root: h.root, confinedReads: true })
    const resumed = await stricter.agent('q2', Session.create('q2' as never, agent.session.snapshotEvents()))
    expect((await stricter.call(resumed, 'run_code', 'c')).text).toMatch(/Saved run rules no longer fit/)
  })

  it('reads the deployment default mode when the log has no sandbox/mode event', async () => {
    const config = ptc({ runRules: { enabled: true, allowedTools: ['bench_status', 'replay', 'run_code'], maxLimits: { replay: 2 } } })
    const confined = await harness(config, { sandboxPolicy: { defaultMode: 'workspace-write' }, confinedReads: true })
    expect((await confined.call(await confined.agent('q3'), 'run_code', 'c')).text).not.toMatch(/refused|denies/)
    const open = await harness(config, { sandboxPolicy: { defaultMode: 'danger-full-access' }, confinedReads: true })
    expect((await open.call(await open.agent('q4'), 'run_code', 'c')).text).toMatch(/tamper-evident only against agents that cannot read/)
    // DSH's own resolution (override, then default) is preferred when available.
    const resolved = await harness(config, { sandboxPolicy: { defaultMode: 'workspace-write', resolve: () => ({ mode: 'danger-full-access' }) }, confinedReads: true })
    expect((await resolved.call(await resolved.agent('q5'), 'run_code', 'c')).text).toMatch(/tamper-evident only against agents that cannot read/)
  })
})

describe('forks inherit approval through lineage (item 2)', () => {
  it('a fork and a grandchild keep the inherited approval and are not treated as missing state', async () => {
    const h = await harness(otx())
    const parent = await h.agent('f-parent')
    await h.call(parent, 'exit_plan_mode', 'plan')
    await h.call(parent, 'replay', 'r1')
    const fork = (id: string, from: { session: Session }, parentId: string) => {
      const events = from.session.snapshotEvents()
      return Session.create(id as never, events, { version: 4, id, createdAt: 1, isSeeded: true, parentSession: parentId, delegationDepth: 0 } as never, events.length as never)
    }
    const child = await h.agent('f-child', fork('f-child', parent, 'f-parent'))
    expect((await h.call(child, 'diff', 'd1')).isError).toBe(false)
    // The inherited replay counts against the child's limit too (2 - 1 = 1 left).
    expect((await h.call(child, 'replay', 'r2')).isError).toBe(false)
    expect((await h.call(child, 'replay', 'r3')).text).toMatch(/limit reached/)
    const grandchild = await h.agent('f-grandchild', fork('f-grandchild', child, 'f-child'))
    expect((await h.call(grandchild, 'diff', 'd2')).isError).toBe(false)
    expect((await h.call(grandchild, 'replay', 'r4')).text).toMatch(/limit reached/)
  })
})

describe('malformed gate state denies everything without breaking agent creation (item 5)', () => {
  it('an authenticated but malformed record denies all tools with a notice', async () => {
    const h = await harness(otx())
    const first = await h.agent('x1')
    await h.call(first, 'exit_plan_mode', 'plan')
    const { createSidecarStore } = await import('../src/state-store.js')
    createSidecarStore(join(h.root, '.dsh/viztools/state'), first.session as never, 'gate').append('rules-approved', { callId: 'bad', rules: 'not-an-object' })
    const restarted = await harness(otx(), { root: h.root })
    const resumed = await restarted.agent('x1', Session.create('x1' as never, first.session.snapshotEvents()))
    for (const tool of ['bench_status', 'diff', 'exit_plan_mode']) expect((await restarted.call(resumed, tool, `t-${tool}`)).text).toMatch(/is malformed.*Every tool is refused/)
    const status = JSON.parse(await readFile(join(h.root, '.dsh/viztools/state', 'x1.status.json'), 'utf8'))
    expect(status.stateBroken).toMatch(/malformed/)
  })

  it('unreadable state (I/O error) also denies all instead of throwing at agent creation', async () => {
    const h = await harness(otx())
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(h.root, '.dsh/viztools/state', 'x2.gate.jsonl'), { recursive: true })
    const agent = await h.agent('x2')
    expect((await h.call(agent, 'bench_status', 'b')).text).toMatch(/could not be read.*Every tool is refused/)
  })
})

describe('invalid saved rules fail closed (fix 4)', () => {
  it('refuses every governed tool with a clear message and an audit record', async () => {
    const h = await harness(otx({ planFirst: { enabled: false } }))
    const agent = await h.agent('i1')
    await h.call(agent, 'propose_run_rules' as never, 'rules')
    const proposal = await h.ctx.tools.execute({ callId: 'rules2' as never, name: 'propose_run_rules', arguments: { deny: ['diff'], limits: { replay: 1 }, notes: [] }, agent: agent as never, signal: new AbortController().signal })
    expect(proposal.isError).toBe(false)
    // Deployment changes: replay's cap shrinks below the approved limit.
    const stricter = await harness({ planFirst: { enabled: false }, runRules: { enabled: true, allowedTools: ['bench_status', 'replay'], maxLimits: { replay: 1 } } }, { root: h.root })
    const resumed = await stricter.agent('i1', Session.create('i1' as never, agent.session.snapshotEvents()))
    const result = await stricter.call(resumed, 'bench_status', 'b1')
    expect(result.text).toMatch(/Saved run rules no longer fit this deployment.*every governed tool is refused/)
    expect((await sidecar(h.root, 'i1')).map((record) => record.kind)).toContain('rules-invalidated')
    expect(stricter.ran).toEqual([])
  })
})

describe('delegation (fix 5)', () => {
  it('is refused by default whenever the gate is active', async () => {
    const h = await harness({ planFirst: { enabled: false }, runRules: { enabled: true, allowedTools: ['subagent', 'replay'], maxLimits: { replay: 1 } } })
    const agent = await h.agent('d1')
    expect((await h.call(agent, 'subagent', 'sa')).text).toMatch(/Delegation \(subagent\) is disabled/)
  })

  it('with opt-in, a child shares the parent counts', async () => {
    const config: GateInput = { planFirst: { enabled: false }, runRules: { enabled: true, allowedTools: ['subagent', 'replay'], maxLimits: { replay: 1 } }, delegation: { allow: true } }
    const h = await harness(config, { tools: ['replay', 'diff', 'bench_status'] })
    const parent = await h.agent('d2')
    let child: Awaited<ReturnType<Harness['agent']>> | undefined
    h.ctx.tools.register(ok('subagent', async () => {
      const session = Session.create('d2-child' as never, [], { version: 4, id: 'd2-child', createdAt: 1, isSeeded: false, delegationDepth: 1 } as never)
      child = await h.agent('d2-child', session)
      return { ok: true }
    }))
    await h.call(parent, 'subagent', 'spawn')
    expect(child).toBeDefined()
    const childReplay = await h.call(child as never, 'replay', 'child-replay')
    expect(childReplay.text).toBe('replay')
    expect((await h.call(parent, 'replay', 'parent-replay')).text).toMatch(/limit reached/)
  })

  it('a child that cannot be attached to its parent gets no fresh budget', async () => {
    const h = await harness({ planFirst: { enabled: false }, runRules: { enabled: true, allowedTools: ['replay'], maxLimits: { replay: 3 } }, delegation: { allow: true } })
    const orphan = await h.agent('orphan', Session.create('orphan' as never, [], { version: 4, id: 'orphan', createdAt: 1, isSeeded: false, delegationDepth: 1 } as never))
    expect((await h.call(orphan, 'replay', 'x')).isError).toBe(true)
  })
})

describe('counting edge cases (fix 6)', () => {
  it('an abort after the reservation but before the body does not count', async () => {
    const h = await harness({ planFirst: { enabled: false }, runRules: { enabled: true, allowedTools: ['replay'], maxLimits: { replay: 1 } } })
    const agent = await h.agent('a1')
    const controller = new AbortController()
    const dispose = h.ctx.tools.guard(() => { controller.abort(); return undefined })
    const aborted = await h.call(agent, 'replay', 'aborted', controller.signal)
    expect(aborted.code).toBe('ABORTED_BEFORE_DISPATCH')
    void dispose
    const h2 = await harness({ planFirst: { enabled: false }, runRules: { enabled: true, allowedTools: ['replay'], maxLimits: { replay: 1 } } }, { root: h.root })
    const resumed = await h2.agent('a1', Session.create('a1' as never, agent.session.snapshotEvents()))
    expect((await h2.call(resumed, 'replay', 'real')).isError).toBe(false)
  })

  it('a tool that does not exist does not use up a limit slot', async () => {
    const h = await harness({ planFirst: { enabled: false }, runRules: { enabled: true, allowedTools: ['replay'], maxLimits: { replay: 1 } } }, { tools: [] })
    const agent = await h.agent('n1')
    expect((await h.call(agent, 'replay', 'missing')).code).toBe('UNKNOWN_TOOL')
    h.ctx.tools.register(ok('replay', () => { h.ran.push('replay'); return { ok: true } }))
    expect((await h.call(agent, 'replay', 'present')).isError).toBe(false)
    expect(h.ran).toEqual(['replay'])
  })

  it('a failed durable write still refuses the call and records the refusal on retry', async () => {
    const h = await harness(otx())
    const agent = await h.agent('w1')
    const dir = join(h.root, '.dsh/viztools/state')
    const blocker = join(dir, 'w1.gate.jsonl')
    await rm(dir, { recursive: true, force: true })
    await writeFile(join(h.root, '.dsh/viztools'), '').catch(async () => {
      await rm(join(h.root, '.dsh/viztools'), { recursive: true, force: true })
      await writeFile(join(h.root, '.dsh/viztools'), '')
    })
    expect((await h.call(agent, 'replay', 'refused-while-broken')).text).toMatch(/Plan not approved/)
    await rm(join(h.root, '.dsh/viztools'), { force: true })
    await h.call(agent, 'bench_status', 'after-repair')
    const kinds = (await readFile(blocker, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line))
    expect(kinds.some((record: { kind: string; data: { callId: string } }) => record.kind === 'refused' && record.data.callId === 'refused-while-broken')).toBe(true)
  })

  it('a missing plan mode tells the user why, in the refusal and the status file', async () => {
    const h = await harness(otx(), { planMode: false })
    const agent = await h.agent('m1')
    expect((await h.call(agent, 'diff', 'd')).text).toMatch(/Plan mode is unavailable in this deployment/)
    const status = JSON.parse(await readFile(join(h.root, '.dsh/viztools/state', 'm1.status.json'), 'utf8'))
    expect(status.planNotice).toMatch(/Plan mode is unavailable/)
  })
})

describe('plugin-record backend (DSH >= 0.2.1)', () => {
  it('uses appendPluginRecord when available and writes no sidecar', async () => {
    const records: { type: string; data: unknown }[] = []
    const api: PluginRecordApi = {
      appendPluginRecord: (_session, type, data) => { records.push({ type, data: JSON.parse(JSON.stringify(data)) }); return records.length },
      pluginRecordOf: (event) => (event as unknown as { record?: { type: string; data: unknown } }).record,
    }
    const h = await harness(otx(), { pluginRecords: api })
    const agent = await h.agent('pr1')
    await h.call(agent, 'exit_plan_mode', 'plan')
    await h.call(agent, 'replay', 'r1')
    expect(records.map((record) => record.type)).toEqual(['plugin:dsh-viztools/gate', 'plugin:dsh-viztools/gate'])
    expect(existsSync(join(h.root, '.dsh/viztools/state', 'pr1.gate.jsonl'))).toBe(false)
    const events = records.map((record, index) => ({ type: record.type, seq: index, time: index, ignorable: true, data: record.data, record }))
    const restarted = await harness(otx(), { pluginRecords: api, root: h.root })
    const resumed = await restarted.agent('pr1', { id: 'pr1', seq: events.length, header: {}, inheritedEventCount: 0, snapshotEvents: () => events } as never)
    expect((await restarted.call(resumed, 'diff', 'd')).isError).toBe(false)
    expect((await readdir(join(h.root, '.dsh/viztools/state')).catch(() => [])).some((name) => name.endsWith('.gate.jsonl'))).toBe(false)
  })
})
