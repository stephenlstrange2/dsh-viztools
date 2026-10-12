import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { toolResultCallId } from './report-trigger.js'

export interface DynamicInputSpec {
  readonly tool: string
  readonly field: string
  readonly pattern: string
}

function messageText(event: SessionEvent): string | undefined {
  if (event.type !== 'tool/result') return undefined
  const message = (event.data as unknown as Record<string, unknown>).message
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return undefined
  const content = (message as Record<string, unknown>).content
  if (!Array.isArray(content)) return undefined
  const texts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null || Array.isArray(block)) continue
    const value = block as Record<string, unknown>
    if (value.type === 'text' && typeof value.text === 'string') texts.push(value.text)
    if (value.type === 'tool-result' && Array.isArray(value.content)) {
      for (const inner of value.content) if (typeof inner === 'object' && inner !== null && !Array.isArray(inner) && (inner as Record<string, unknown>).type === 'text' && typeof (inner as Record<string, unknown>).text === 'string') texts.push((inner as Record<string, unknown>).text as string)
    }
  }
  return texts.join('\n')
}

export function extractDynamicInputs(events: readonly SessionEvent[], specs: Readonly<Record<string, DynamicInputSpec>>): Record<string, string> {
  const calls = new Map<string, string>()
  const values: Record<string, string> = {}
  for (const event of events) {
    if (event.type === 'tool/call') {
      const data = event.data as unknown as Record<string, unknown>
      if (typeof data.callId === 'string' && typeof data.name === 'string') calls.set(data.callId, data.name)
      continue
    }
    const callId = toolResultCallId(event)
    if (callId === undefined) continue
    const tool = calls.get(callId)
    const text = messageText(event)
    if (tool === undefined || text === undefined) continue
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch { continue }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue
    for (const [name, spec] of Object.entries(specs)) {
      if (spec.tool !== tool) continue
      const value = (parsed as Record<string, unknown>)[spec.field]
      if (typeof value !== 'string' || !(new RegExp(spec.pattern).test(value))) throw new Error(`dynamic input ${name} from ${tool}.${spec.field} failed validation`)
      values[name] = value
    }
  }
  for (const name of Object.keys(specs)) if (values[name] === undefined) throw new Error(`dynamic input ${name} was not found in durable tool results`)
  return values
}

export function substitutePlaceholders(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const value = values[name]
    if (value === undefined) throw new Error(`missing dynamic input placeholder: ${name}`)
    return value
  })
}

export async function containedRealpath(root: string, candidate: string, label: string): Promise<string> {
  const realRoot = await realpath(root)
  const realTarget = await realpath(resolve(root, candidate))
  const rel = relative(realRoot, realTarget)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`${label} resolves outside trusted root: ${realTarget}`)
  return realTarget
}
