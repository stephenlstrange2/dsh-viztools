#!/usr/bin/env node
// Real-profile integration test for the locked OTX console topology.
//
// Boots the real `dsh` web app with a disposable DSH_HOME whose profile mirrors the OTX
// console (see test/integration/otx-console/cordis.patch.yml), a scripted mock LLM, a stdio
// MCP fixture that registers its tools after agent creation, and a test-only answerer that
// approves plan and run-rules reviews. A headless browser submits one prompt; the script then
// asserts on the durable session log, the published report state, the fixture's call log,
// and the authenticated report route, restarts DSH, and checks that resume keeps the report.
//
// Requirements: `dsh` 0.2.0-rc.2 on PATH, uv, a built plugin (`pnpm build`), and
// playwright-core plus a Chromium binary (PLAYWRIGHT_CORE_DIR / CHROMIUM_PATH).
import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { appendFile, cp, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir, homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startMockLlm } from '../test/integration/otx-console/mock-llm.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixtures = join(repo, 'test', 'integration', 'otx-console')
const keep = process.argv.includes('--keep')
const require = createRequire(join(process.env.PLAYWRIGHT_CORE_DIR ?? join(homedir(), '.hermes', 'hermes-agent', 'node_modules'), 'noop.js'))
const { chromium } = require('playwright-core')
const chromiumPath = process.env.CHROMIUM_PATH ?? join(homedir(), '.cache', 'ms-playwright', 'chromium_headless_shell-1243', 'chrome-headless-shell-linux64', 'chrome-headless-shell')

const failures = []
function check(label, condition, detail = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`)
  if (!condition) failures.push(label)
}

async function freePort() {
  const { createServer } = await import('node:net')
  return await new Promise((res) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)) }) })
}

async function walk(dir, predicate, out = []) {
  let entries = []
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) await walk(path, predicate, out)
    else if (predicate(path)) out.push(path)
  }
  return out
}

function readJsonl(text) {
  return text.split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return undefined } }).filter(Boolean)
}

function startDsh(env, cwd, port, logPath) {
  const child = spawn('dsh', ['--profile', 'otx-it', '--no-open', '--host', '127.0.0.1', '--port', String(port)], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  const onData = (chunk) => { output += chunk.toString('utf8'); void writeFile(logPath, output) }
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)
  const ready = new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`dsh did not start:\n${output.slice(-4000)}`)), 240_000)
    const poll = setInterval(() => {
      const match = /dsh web: (http:\/\/\S+)/.exec(output)
      if (match) { clearInterval(poll); clearTimeout(timer); res(match[1]) }
      if (child.exitCode !== null) { clearInterval(poll); clearTimeout(timer); rej(new Error(`dsh exited ${child.exitCode}:\n${output.slice(-4000)}`)) }
    }, 200)
  })
  return { child, ready, output: () => output }
}

async function stopDsh(proc) {
  if (proc.child.exitCode !== null) return
  await new Promise((res) => { const t = setTimeout(() => { proc.child.kill('SIGKILL'); res() }, 15_000); proc.child.once('exit', () => { clearTimeout(t); res() }); proc.child.kill('SIGTERM') })
}

async function dismissDialogs(page) {
  for (const name of ['Continue', 'Got it', 'OK', 'Close']) {
    const button = page.getByRole('button', { name })
    if (await button.count()) { await button.first().click().catch(() => undefined); await page.waitForTimeout(400) }
  }
  await page.keyboard.press('Escape')
}

async function chooseWorkspace(page, workspace) {
  const label = workspace.split('/').at(-1)
  // A fresh DSH home starts on the default workspace (the launch cwd): nothing to choose.
  if (await page.getByText('Choose workspace').count() === 0) return
  await page.getByText('Choose workspace').first().click()
  await page.waitForTimeout(800)
  const existing = page.getByRole('menuitem', { name: label })
  if (await existing.count()) { await existing.first().click(); return }
  await page.getByText('Add workspace…').click()
  await page.waitForTimeout(1200)
  const input = page.getByRole('dialog').locator('input[type=text]')
  await input.first().fill(workspace)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1500)
  const after = page.getByRole('menuitem', { name: label })
  if (await after.count()) await after.first().click()
}

const root = await mkdtemp(join(tmpdir(), 'viztools-otx-it-'))
const home = join(root, 'home')
const profile = join(home, 'profiles', 'otx-it')
const workspace = join(root, 'otx-it-workspace')
const logs = join(root, 'logs')
await mkdir(join(profile, 'node_modules'), { recursive: true })
await mkdir(workspace, { recursive: true })
await mkdir(logs, { recursive: true })
await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'dsh-profile-otx-it', private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-viztools'], patchReload: 'startup' } } }, null, 2))
await writeFile(join(profile, 'cordis.yml'), '[]\n')
await cp(join(fixtures, 'cordis.patch.yml'), join(profile, 'cordis.patch.yml'))
await symlink(repo, join(profile, 'node_modules', 'dsh-viztools'))
await symlink(join(fixtures, 'answerer'), join(profile, 'node_modules', 'viztools-it-answerer'))
// Reuse the developer's uv cache so the managed environment provisions quickly.
const llm = await startMockLlm()
const env = {
  ...process.env,
  DSH_HOME: home,
  OTX_LLM_API_KEY: 'mock-key',
  OTX_LLM_BASE_URL: `http://127.0.0.1:${llm.address().port}/v1`,
  OTX_FIXTURE_MCP: join(fixtures, 'otx-mcp-fixture.mjs'),
  OTX_FIXTURE_DELAY_MS: '2500',
  OTX_FIXTURE_CALL_LOG: join(logs, 'mcp-calls.jsonl'),
  MOCK_LLM_LOG: join(logs, 'llm.jsonl'),
  VIZTOOLS_IT_QUESTION_LOG: join(logs, 'questions.jsonl'),
}
// The mock LLM runs in this process; make it log too.
process.env.MOCK_LLM_LOG = env.MOCK_LLM_LOG
console.log(`integration root: ${root}`)

let dsh
let browser
try {
  const port = await freePort()
  dsh = startDsh(env, workspace, port, join(logs, 'dsh-1.log'))
  const url = await dsh.ready
  const origin = new URL(url).origin
  check('console boots with the locked managed-readonly runtime', !/did not activate|resolves outside the workspace/.test(dsh.output()), dsh.output().match(/dsh-viztools[^\n]*Error[^\n]*/)?.[0] ?? '')

  browser = await chromium.launch({ executablePath: chromiumPath, args: ['--disable-crash-reporter', '--no-crashpad', '--disable-gpu'], env: { ...process.env, HOME: join(root, 'chrome-home') } })
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
  const pageErrors = []
  page.on('console', (message) => { if (/not visible|planMode|Unhandled|viztools/i.test(message.text())) pageErrors.push(message.text().slice(0, 400)) })
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.waitForTimeout(2000)
  await dismissDialogs(page)
  await chooseWorkspace(page, workspace)
  await page.waitForTimeout(2500)
  const box = page.locator('[contenteditable="true"], textarea').first()
  await box.click()
  await page.keyboard.type('Validate fixture.snoop on the bench.')
  await page.keyboard.press('Enter')
  let done = false
  for (let i = 0; i < 60 && !done; i++) {
    await page.waitForTimeout(3000)
    done = /INTEGRATION-DONE/.test(await page.evaluate(() => document.body.innerText))
  }
  await page.screenshot({ path: join(logs, 'console.png') })
  check('scripted run completes in the real web console', done)
  check('no gate visibility or planMode errors surfaced', !pageErrors.some((text) => /not visible|requires the planMode/.test(text)) && !/not visible to agent|requires the planMode service/.test(dsh.output()), pageErrors.join(' | '))

  // Durable session log (DSH 0.2 writes zstd-compressed v4 JSONL) and the plugin sidecar.
  const sessionLogs = await walk(join(home, 'sessions'), (path) => /session\.v\d+\.jsonl(\.zstd)?$/.test(path))
  const readSession = (path) => readJsonl(path.endsWith('.zstd') ? execFileSync('zstd', ['-dc', path]).toString('utf8') : execFileSync('cat', [path]).toString('utf8'))
  const stateDir = join(workspace, '.dsh', 'viztools', 'state')
  let typed = []
  let sessionId = ''
  let sessionLog = ''
  for (const path of sessionLogs) {
    const id = path.split('/').at(-2)
    if (existsSync(join(stateDir, `${id}.gate.jsonl`))) { typed = readSession(path); sessionLog = path; sessionId = id; break }
  }
  check('session log and gate sidecar found', sessionLog !== '', sessionLogs.join(', '))
  check('no custom (non-ignorable) viztools event types in session.jsonl', !typed.some((entry) => String(entry.type).startsWith('viztools') && entry.ignorable !== true), typed.filter((entry) => String(entry.type).startsWith('viztools')).map((entry) => entry.type).join(','))
  const readSidecar = async (channel) => readJsonl(await readFile(join(stateDir, `${sessionId}.${channel}.jsonl`), 'utf8').catch(() => ''))
  const gateRecords = await readSidecar('gate')
  const refusals = gateRecords.filter((record) => record.kind === 'refused').map((record) => record.data)
  const starts = (records, tool) => {
    const started = new Set()
    for (const record of records) {
      if (record.data.tool !== tool) continue
      if (record.kind === 'started') started.add(record.data.callId)
      if (record.kind === 'not-started') started.delete(record.data.callId)
    }
    return started.size
  }
  check('pre-approval refusal persisted live', refusals.some((refusal) => refusal.code === 'PLAN_NOT_APPROVED' && refusal.beforeApproval === true && refusal.tool === 'mcp__otx__replay_tx_only'), JSON.stringify(refusals))
  check('plan approval persisted', gateRecords.some((record) => record.kind === 'plan-approved'))
  const approved = gateRecords.find((record) => record.kind === 'rules-approved')
  check('run rules approved (no allowlist = deployment ceiling)', approved !== undefined && approved.data.rules.allow === undefined, JSON.stringify(approved?.data.rules))
  const liveReplayStarts = starts(gateRecords, 'mcp__otx__replay_tx_only')
  check('parallel limited calls: exactly one replay started', liveReplayStarts === 1, `started=${liveReplayStarts}`)
  check('parallel limited calls: the other was refused at the limit', refusals.filter((refusal) => refusal.code === 'RUN_RULE_LIMIT' && refusal.tool === 'mcp__otx__replay_tx_only').length === 1)
  check('session-rule denial persisted', refusals.some((refusal) => refusal.code === 'RUN_RULE_DENIED' && refusal.tool === 'mcp__otx__emit_otx'))
  check('terminal call recorded as started', starts(gateRecords, 'mcp__otx__finalize_run') === 1)
  const ids = gateRecords.filter((record) => record.kind === 'refused' || record.kind === 'started').map((record) => `${record.kind}:${record.data.callId}`)
  check('refusal and start records are not duplicated', new Set(ids).size === ids.length)
  const chain = gateRecords.every((record, index) => record.i === index)
  check('gate sidecar is a contiguous hash chain', chain && gateRecords[0]?.prev === '')
  check('gate sidecar is owner-only (0600)', ((await stat(join(stateDir, `${sessionId}.gate.jsonl`))).mode & 0o777) === 0o600)

  const calls = existsSync(env.OTX_FIXTURE_CALL_LOG) ? readJsonl(await readFile(env.OTX_FIXTURE_CALL_LOG, 'utf8')) : []
  check('bench saw exactly one replay', calls.filter((call) => call.name === 'replay_tx_only').length === 1, JSON.stringify(calls.map((call) => call.name)))
  check('bench never saw a denied call', !calls.some((call) => call.name === 'emit_otx'))

  // Report generation is asynchronous after the terminal result.
  const statePath = join(workspace, '.dsh', 'reports', sessionId, 'state.json')
  let state
  for (let i = 0; i < 80; i++) {
    try { state = JSON.parse(await readFile(statePath, 'utf8')) } catch { state = undefined }
    if (state?.status === 'available' || state?.status === 'failed') break
    await new Promise((res) => setTimeout(res, 1500))
  }
  check('report state published as available', state?.status === 'available', JSON.stringify(state))
  check('report available record persisted on the report channel', (await readSidecar('report')).some((record) => record.kind === 'available'))
  check('state carries the authenticated route', state?.url === `/api/viztools/report?session=${encodeURIComponent(sessionId)}`)

  const served = await page.request.get(`${origin}${state?.url ?? '/api/viztools/report'}`)
  check('authenticated report route serves the export', served.status() === 200 && /<html/i.test(await served.text()), `status=${served.status()}`)
  check('served report is sandboxed to an opaque origin', /sandbox allow-scripts/.test(served.headers()['content-security-policy'] ?? ''))
  const traversal = await page.request.get(`${origin}/api/viztools/report?session=..%2F..%2Fetc`)
  check('report route rejects traversal session ids', traversal.status() === 400, `status=${traversal.status()}`)
  const anonymous = await (await chromium.launch({ executablePath: chromiumPath, args: ['--disable-gpu'] })).newContext()
  const unauthenticated = await anonymous.request.get(`${origin}${state?.url ?? '/api/viztools/report'}`)
  check('report route requires DSH authentication', unauthenticated.status() === 401 || unauthenticated.status() === 403, `status=${unauthenticated.status()}`)
  await anonymous.browser()?.close()

  const sidebar = await page.request.get(`${origin}/api/viztools/sidebar-url?session=${encodeURIComponent(sessionId)}`)
  const sidebarJson = await sidebar.json().catch(() => ({}))
  check('sidebar URL carries session and report_url for the viewer', typeof sidebarJson.browserUrl === 'string' && sidebarJson.browserUrl.includes(`session=${encodeURIComponent(sessionId)}`) && sidebarJson.browserUrl.includes('report_url='))

  if (typeof sidebarJson.browserUrl === 'string') {
    const viewer = await browser.newPage({ viewport: { width: 1400, height: 900 } })
    await viewer.goto(sidebarJson.browserUrl, { waitUntil: 'networkidle' }).catch(() => undefined)
    let rendered = ''
    for (let i = 0; i < 20 && !/Run report/.test(rendered); i++) {
      await viewer.waitForTimeout(1500)
      rendered = await viewer.evaluate(() => document.body.innerText).catch(() => '')
    }
    await viewer.screenshot({ path: join(logs, 'viewer.png') })
    check('locked viewer shows the finished report for the session', /Run report/.test(rendered) && rendered.includes(sessionId), rendered.slice(0, 200).replace(/\s+/g, ' '))
    check('locked viewer offers the authenticated report link', /Open the report in a new tab/.test(rendered))
    const hostile = sidebarJson.browserUrl.replace(/session=[^&]+/, 'session=..%2F..%2Fetc')
    await viewer.goto(hostile, { waitUntil: 'networkidle' }).catch(() => undefined)
    let hostileText = ''
    for (let i = 0; i < 12 && !/Report unavailable/.test(hostileText); i++) {
      await viewer.waitForTimeout(1000)
      hostileText = await viewer.evaluate(() => document.body.innerText).catch(() => '')
    }
    check('locked viewer rejects a traversal session id', /Report unavailable/.test(hostileText))
    await viewer.close()
  }

  // Restart. First simulate a session written by an older dsh-viztools: inject a legacy,
  // non-ignorable viztools-* event (rc.2 refuses such logs) and repair it with the CLI.
  // While DSH still holds the session lease, the repair must refuse to touch the log.
  const repairCliLive = join(repo, 'bin', 'dsh-viztools-repair.mjs')
  let refusedWhileLive = ''
  try { execFileSync(process.execPath, [repairCliLive, '--dsh-home', home, '--workspace', workspace, '--session', sessionId], { stdio: ['ignore', 'pipe', 'pipe'] }) } catch (error) { refusedWhileLive = String(error.stdout ?? '') }
  check('repair refuses a session DSH still holds (session.lock lease)', /DSH holds the session lease/.test(refusedWhileLive), refusedWhileLive.trim().split('\n')[0])
  await browser.close(); browser = undefined
  await stopDsh(dsh)
  const liveRecords = await readSidecar('gate')
  if (process.env.VIZTOOLS_IT_SKIP_LEGACY !== '1') {
    const raw = execFileSync('zstd', ['-dc', sessionLog]).toString('utf8')
    const lastSeq = Math.max(...readJsonl(raw).filter((entry) => typeof entry.seq === 'number').map((entry) => entry.seq))
    const legacy = { type: 'viztools-gate/change', seq: lastSeq + 1, time: Date.now(), data: { kind: 'refused', version: 1, callId: 'legacy-1', tool: 'mcp__otx__emit_otx', reason: 'Plan not approved yet.' } }
    const injected = `${raw.endsWith('\n') ? raw : `${raw}\n`}${JSON.stringify(legacy)}\n`
    // Append one more zstd frame, exactly as an older plugin's DSH batch write would have.
    await appendFile(sessionLog, execFileSync('zstd', ['-q', '-c', '-'], { input: `${JSON.stringify(legacy)}\n` }))
    const repairCli = join(repo, 'bin', 'dsh-viztools-repair.mjs')
    const dry = execFileSync(process.execPath, [repairCli, '--dsh-home', home, '--workspace', workspace, '--dry-run']).toString('utf8')
    check('repair dry-run reports the legacy session and writes nothing', /would-convert/.test(dry) && execFileSync('zstd', ['-dc', sessionLog]).toString('utf8') === injected, dry.trim().split('\n')[0])
    const repaired = execFileSync(process.execPath, [repairCli, '--dsh-home', home, '--workspace', workspace]).toString('utf8')
    check('repair converts the legacy event and keeps a backup', /converted/.test(repaired) && (await readdir(dirname(sessionLog))).some((name) => name.includes('viztools-backup')), repaired.trim().split('\n')[0])

  }

  const port2 = await freePort()
  dsh = startDsh(env, workspace, port2, join(logs, 'dsh-2.log'))
  const url2 = await dsh.ready
  browser = await chromium.launch({ executablePath: chromiumPath, args: ['--disable-crash-reporter', '--no-crashpad', '--disable-gpu'], env: { ...process.env, HOME: join(root, 'chrome-home') } })
  // The OTX console VM resolution: the report must fill the right sidebar, not an 85 px strip.
  const page2 = await browser.newPage({ viewport: { width: 1910, height: 916 } })
  await page2.goto(url2, { waitUntil: 'networkidle' })
  await page2.waitForTimeout(2000)
  await dismissDialogs(page2)
  // Open the exact persisted session from the sidebar list, as a returning operator would.
  let history = ''
  for (let i = 0; i < 30 && !/INTEGRATION-DONE|Failed to load history/.test(history); i++) {
    const link = page2.getByText('OTX integration run', { exact: true }).first()
    if (await link.count()) await link.click().catch(() => undefined)
    await page2.waitForTimeout(1000)
    history = await page2.evaluate(() => document.body.innerText)
  }
  check('reopened the original session (not a new one)', /INTEGRATION-DONE/.test(history) || /Failed to load history/.test(history), history.slice(0, 160).replace(/\s+/g, ' '))
  check('persisted session history loads after a DSH restart', /INTEGRATION-DONE/.test(history) && !/Failed to load history|unknown to this harness/.test(history), (/contains event type "[^"]+"/.exec(history) ?? [history.slice(0, 120).replace(/\s+/g, ' ')])[0])
  // A follow-up prompt forces the persisted agent to be resumed; the script then tries one
  // more limited replay, which a correctly replayed count (1 of 1) must refuse.
  const box2 = page2.locator('[contenteditable="true"], textarea').first()
  await box2.click()
  await page2.keyboard.type('RESUME-CHECK: summarize the run.')
  await page2.keyboard.press('Enter')
  let resumedTurn = false
  for (let i = 0; i < 40 && !resumedTurn; i++) {
    await page2.waitForTimeout(2000)
    resumedTurn = /RESUME-DONE/.test(await page2.evaluate(() => document.body.innerText))
  }
  check('resumed session accepts a new turn', resumedTurn)
  await new Promise((res) => setTimeout(res, 1500))
  const resumedRecords = await readSidecar('gate')
  check('resumed counts equal the live counts', starts(resumedRecords, 'mcp__otx__replay_tx_only') === liveReplayStarts && starts(resumedRecords, 'mcp__otx__finalize_run') === starts(liveRecords, 'mcp__otx__finalize_run'), `live=${liveReplayStarts} resumed=${starts(resumedRecords, 'mcp__otx__replay_tx_only')}`)
  check('resumed gate refuses the replay at the limit', resumedRecords.slice(liveRecords.length).some((record) => record.kind === 'refused' && record.data.code === 'RUN_RULE_LIMIT' && record.data.tool === 'mcp__otx__replay_tx_only'), JSON.stringify(resumedRecords.slice(liveRecords.length).map((record) => [record.kind, record.data.code])))
  const originalHasResume = execFileSync('zstd', ['-dc', sessionLog]).toString('utf8').includes('RESUME-CHECK')
  check('the resumed turn ran in the original session', originalHasResume)
  const benchAfter = readJsonl(await readFile(env.OTX_FIXTURE_CALL_LOG, 'utf8'))
  check('bench still saw exactly one replay after resume', benchAfter.filter((call) => call.name === 'replay_tx_only').length === 1)

  // Report frame height inside the right sidebar at 1910x916.
  let frameHeight = 0
  for (let i = 0; i < 30 && frameHeight === 0; i++) {
    for (const frame of page2.frames()) {
      const handle = await frame.$('iframe[data-viztools-report]').catch(() => null)
      const box = handle === null ? null : await handle.boundingBox().catch(() => null)
      if (box !== null && box.height > frameHeight) frameHeight = box.height
    }
    if (frameHeight === 0) await page2.waitForTimeout(1000)
  }
  await page2.screenshot({ path: join(logs, 'resume.png') })
  check('report iframe in the right sidebar is at least 60% of the viewport height (1910x916)', frameHeight >= 0.6 * 916, `height=${Math.round(frameHeight)}px`)
  const resumed = JSON.parse(await readFile(statePath, 'utf8'))
  check('resume keeps the available report state', resumed.status === 'available', JSON.stringify(resumed))
  const servedAgain = await page2.request.get(`${new URL(url2).origin}${state?.url ?? ''}`)
  check('report still served after restart', servedAgain.status() === 200, `status=${servedAgain.status()}`)
  check('no unhandled rejections in the host log', !/Unhandled|unhandledRejection/i.test(dsh.output()))
} catch (error) {
  failures.push(String(error))
  console.error(error)
  for (const context of browser?.contexts() ?? []) {
    for (const [index, open] of context.pages().entries()) {
      await open.screenshot({ path: join(logs, `failure-${index}.png`) }).catch(() => undefined)
      console.error((await open.evaluate(() => document.body.innerText).catch(() => '')).slice(0, 1500))
    }
  }
} finally {
  await browser?.close().catch(() => undefined)
  if (dsh !== undefined) await stopDsh(dsh)
  llm.close()
  console.log(`logs: ${logs}`)
  if (!keep && failures.length === 0) await rm(root, { recursive: true, force: true })
}
if (failures.length > 0) {
  console.error(`\n${failures.length} integration check(s) failed:\n- ${failures.join('\n- ')}`)
  process.exit(1)
}
console.log('\nOTX console integration passed')
