import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { containedRealpath, extractDynamicInputs, substitutePlaceholders } from '../src/dynamic-inputs.js'

const events = [
  { type: 'tool/call', seq: 0, time: 1, data: { turn: 1, step: 1, callId: 'start-1', name: 'mcp__otx__start_run', arguments: '{}' } },
  { type: 'tool/result', seq: 1, time: 2, data: { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'start-1' }, content: [{ type: 'tool-result', toolCallId: 'start-1', isError: false, content: [{ type: 'text', text: '{"run_id":"run-abc_123"}' }] }] } } },
] as never

describe('dynamic report inputs', () => {
  it('extracts a validated run id from durable modern tool result', () => {
    expect(extractDynamicInputs(events, { runId: { tool: 'mcp__otx__start_run', field: 'run_id', pattern: '^[A-Za-z0-9_-]+$' } })).toEqual({ runId: 'run-abc_123' })
  })

  it('substitutes only configured placeholders', () => {
    expect(substitutePlaceholders('runs/{runId}/audit.jsonl', { runId: 'run-1' })).toBe('runs/run-1/audit.jsonl')
    expect(() => substitutePlaceholders('runs/{missing}', {})).toThrow(/missing/)
  })

  it('rejects invalid extracted identifiers', () => {
    expect(() => extractDynamicInputs(events, { runId: { tool: 'mcp__otx__start_run', field: 'run_id', pattern: '^safe$' } })).toThrow(/failed validation/)
  })

  it('rejects symlink escapes after realpath', async () => {
    const root = await mkdtemp(join(tmpdir(), 'viztools-input-'))
    const outside = await mkdtemp(join(tmpdir(), 'viztools-outside-'))
    await writeFile(join(outside, 'audit.jsonl'), '{}')
    await mkdir(join(root, 'runs'))
    await symlink(outside, join(root, 'runs', 'run-1'))
    await expect(containedRealpath(root, 'runs/run-1/audit.jsonl', 'audit')).rejects.toThrow(/outside trusted root/)
  })
})
