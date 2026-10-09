import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { approvedGateChange, otxFinalizeCall, otxPtcStart, otxToolResultContentBlock } from './fixtures/otx-events.js'

/**
 * Phase-0 release blockers. Every todo is an acceptance test that must be
 * implemented and made green before locked-console promotion. `it.todo` keeps
 * the ordinary developer suite usable while exposing the unfinished security
 * contract in test output.
 */
describe('OTX hardening release blockers', () => {

  it.todo('later rule approval merges denies and lowers limits instead of replacing policy')
  it.todo('live accepted-call count equals replayed count after refusal and resume')
  it.todo('saved rules are revalidated against a stricter deployment fingerprint')
  it.todo('fork/subagent creation is refused under governed OTX run policy')
  it.todo('PTC plan flow can reach exit_plan_mode without opening non-planning tools')

  it.todo('terminal report waits for matching durable tool/result before reading trajectory')
  it.todo('terminal report matches modern tool-result content block by call id')
  it.todo('hung report export times out, terminates, and does not block turn stopping')
  it.todo('turn-stop report trigger coalesces instead of exporting every changing session seq')
  it.todo('fresh locked console serves plan-in-progress placeholder then active report')
  it.todo('run id extracted from durable start_run result resolves report artifacts')

  it.todo('token is absent from process argv and supplied through a mode-0600 token file')
  it.todo('template and extra-input symlink escapes are rejected after realpath')
  it.todo('session id cannot escape or collide in report output directory')
  it.todo('requirements lock content hash changes runtime install marker')
  it.todo('default report redacts tokenized URLs and bounds large tool arguments')

  it('keeps realistic modern DSH and PTC fixture shapes', () => {
    expect(otxToolResultContentBlock.data.message.content[0].isError).toBe(false)
    expect(otxToolResultContentBlock.data.message.source.callId).toBe('finalize-1')
    expect(otxFinalizeCall.data.name).toBe('mcp__otx__finalize_run')
    expect(otxPtcStart.data.subCallId).toBe('ptc-1')
    expect(approvedGateChange.data.kind).toBe('approved')
  })

  it('preserves content-block loader handling required by real OTX logs', () => {
    const source = readFileSync(new URL('../python/dsh_viztools/session.py', import.meta.url), 'utf8')
    expect(source).toContain('any(b.get("isError") is True for b in blocks)')
    expect(source).toContain('message.get("source")')
  })
})
