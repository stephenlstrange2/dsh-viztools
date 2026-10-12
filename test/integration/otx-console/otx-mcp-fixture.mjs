#!/usr/bin/env node
// Minimal stdio MCP server exposing the OTX console tool names. It deliberately delays its
// `initialize` reply so its tools register with DSH *after* agents already exist, reproducing
// the asynchronous MCP registration the real console has.
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const delayMs = Number(process.env.OTX_FIXTURE_DELAY_MS ?? 2500)
const callLog = process.env.OTX_FIXTURE_CALL_LOG
const object = { type: 'object', properties: { run_id: { type: 'string' }, snoop: { type: 'string' } }, additionalProperties: true }
const TOOLS = ['bench_status', 'describe_profile', 'start_run', 'parse_snoop', 'get_messages', 'propose_sequence', 'emit_otx', 'replay_tx_only', 'diff', 'finalize_run', 'abandon_run']

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function result(name, args) {
  if (callLog) appendFileSync(callLog, `${JSON.stringify({ name, args })}\n`)
  switch (name) {
    case 'bench_status': return { bus: 'sim', available_snoops: ['fixture.snoop'] }
    case 'start_run': return { run_id: 'run-it-1', snoop: args.snoop ?? 'fixture.snoop' }
    case 'replay_tx_only': return { run_id: args.run_id, replayed: true }
    case 'finalize_run': return { run_id: args.run_id, finalized: true }
    default: return { ok: true, tool: name }
  }
}

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (line.trim() === '') return
  let message
  try { message = JSON.parse(line) } catch { return }
  if (message.id === undefined) return
  if (message.method === 'initialize') {
    setTimeout(() => send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'otx-fixture', version: '0.0.0' } } }), delayMs)
  } else if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS.map((name) => ({ name, description: `OTX fixture ${name}`, inputSchema: object })) } })
  } else if (message.method === 'tools/call') {
    const name = message.params?.name
    const args = message.params?.arguments ?? {}
    send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(result(name, args)) }], isError: false } })
  } else if (message.method === 'ping') {
    send({ jsonrpc: '2.0', id: message.id, result: {} })
  } else {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `unsupported ${message.method}` } })
  }
})
