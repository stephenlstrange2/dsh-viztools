import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { describe, expect, it } from 'vitest'

const noop = defineTool({
  name: 'emit_otx', description: 'fixture', parameters: {},
  output: { schema: { type: 'object', additionalProperties: false, properties: { ran: { type: 'boolean', required: true } } }, render: () => [{ type: 'text', text: 'ran' }] },
  async execute() { return { ran: true } },
})

describe('ToolRuntime monotonic guard ordering', () => {
  it('guard denial survives an earlier allow decision', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {} as never).await()
    await ctx.plugin(ToolRuntime).await()
    ctx.tools.register(noop)
    ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }))
    ctx.tools.guard(() => 'Plan not approved yet.')
    const result = await ctx.tools.execute({ callId: 'c1' as never, name: 'emit_otx', arguments: {}, signal: new AbortController().signal })
    expect(result.isError).toBe(true)
    expect(result.isError).toBe(true)
    expect(result.content).not.toEqual([])
  })

  it('guard denial survives an earlier ask decision', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {} as never).await()
    await ctx.plugin(ToolRuntime).await()
    ctx.tools.register(noop)
    ctx.on('tools/pre-execute', async () => ({ kind: 'ask', reason: 'user may allow' }))
    ctx.tools.guard(() => 'Plan not approved yet.')
    const result = await ctx.tools.execute({ callId: 'c2' as never, name: 'emit_otx', arguments: {}, signal: new AbortController().signal })
    expect(result.isError).toBe(true)
    expect(result.isError).toBe(true)
    expect(result.content).not.toEqual([])
  })
})
