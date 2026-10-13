// Scripted OpenAI-compatible chat-completions server for the OTX console integration test.
// Each request is answered from the number of assistant tool-call turns already in the
// conversation, so the run is deterministic regardless of timing.
import { appendFileSync } from 'node:fs'
import { createServer } from 'node:http'


/** The scripted run: each entry is one assistant step (tool calls or final text). */
export const SCRIPT = [
  // Planning tool before approval: allowed.
  [{ name: 'mcp__otx__bench_status', args: {} }],
  // Non-planning tool before approval: refused by the gate and audited durably.
  [{ name: 'mcp__otx__replay_tx_only', args: { run_id: 'run-it-1' } }],
  // Control tool: plan submission (auto-approved by the fixture answerer).
  [{ name: 'exit_plan_mode', args: { plan: '# Validate snoop\n\n1. Start run\n2. Replay once\n3. Finalize' } }],
  // Control tool: narrowing rules without an allowlist (deployment ceiling stays), replay capped at 1.
  [{ name: 'propose_run_rules', args: { deny: ['mcp__otx__emit_otx'], limits: { mcp__otx__replay_tx_only: 1 }, notes: ['no edits after step 40'] } }],
  [{ name: 'mcp__otx__start_run', args: { snoop: 'fixture.snoop' } }],
  // Two parallel limited calls: exactly one may start.
  [{ name: 'mcp__otx__replay_tx_only', args: { run_id: 'run-it-1' } }, { name: 'mcp__otx__replay_tx_only', args: { run_id: 'run-it-1' } }],
  // Denied by the approved session rules.
  [{ name: 'mcp__otx__emit_otx', args: { run_id: 'run-it-1' } }],
  // Terminal tool: triggers the plugin-driven report.
  [{ name: 'mcp__otx__finalize_run', args: { run_id: 'run-it-1' } }],
  'Run run-it-1 finalized. INTEGRATION-DONE',
]

function text(message) {
  return typeof message.content === 'string' ? message.content : Array.isArray(message.content) ? message.content.map((part) => part.text ?? '').join('') : ''
}

/** After a restart the harness sends RESUME-CHECK: try one more limited replay, then finish. */
function resumeEntry(messages) {
  const index = messages.findLastIndex((message) => message.role === 'user' && text(message).includes('RESUME-CHECK'))
  if (index < 0) return undefined
  const calls = messages.slice(index).filter((message) => message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0).length
  return calls === 0 ? [{ name: 'mcp__otx__replay_tx_only', args: { run_id: 'run-it-1' } }] : 'Resumed. RESUME-DONE'
}

function stepIndex(messages) {
  return messages.filter((message) => message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0).length
}

function sse(res, chunks) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}

function base(model) {
  return { id: `chatcmpl-${Date.now()}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model }
}

function textChunks(model, text) {
  return [
    { ...base(model), choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] },
    { ...base(model), choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { ...base(model), choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
  ]
}

function toolChunks(model, step, calls) {
  return [
    { ...base(model), choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: calls.map((call, index) => ({ index, id: `call_${step}_${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) }, finish_reason: null }] },
    { ...base(model), choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    { ...base(model), choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
  ]
}

export function startMockLlm(port = 0) {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      if (req.method === 'GET' && req.url?.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'moonshotai/kimi-k3' }, { id: 'deepseek/deepseek-v4.1-flash' }] }))
        return
      }
      let request = {}
      try { request = JSON.parse(body || '{}') } catch { /* ignore */ }
      const messages = Array.isArray(request.messages) ? request.messages : []
      const model = request.model ?? 'mock'
      const tools = Array.isArray(request.tools) ? request.tools.map((tool) => tool.function?.name) : []
      // Auxiliary requests (session titles, compaction) carry no tools: answer with plain text.
      if (tools.length === 0) {
        if (process.env.MOCK_LLM_LOG) appendFileSync(process.env.MOCK_LLM_LOG, `${JSON.stringify({ kind: 'aux', model })}\n`)
        sse(res, textChunks(model, 'OTX integration run'))
        return
      }
      const step = stepIndex(messages)
      const entry = resumeEntry(messages) ?? SCRIPT[Math.min(step, SCRIPT.length - 1)]
      if (process.env.MOCK_LLM_LOG) appendFileSync(process.env.MOCK_LLM_LOG, `${JSON.stringify({ kind: 'step', step, tools: tools.sort(), lastTool: messages.filter((m) => m.role === 'tool').map((m) => String(m.content).slice(0, 300)).at(-1) })}\n`)
      if (typeof entry === 'string') sse(res, textChunks(model, entry))
      else sse(res, toolChunks(model, resumeEntry(messages) === undefined ? step : `r${step}`, entry))
    })
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = await startMockLlm(Number(process.env.MOCK_LLM_PORT ?? 0))
  console.log(`mock-llm listening on ${server.address().port}`)
}
