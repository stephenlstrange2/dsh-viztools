import type { SessionEvent } from '@deepseek-ai/dsh-session'

export interface PendingTerminalTrigger {
  readonly callId: string
  readonly tool: string
}

export function toolResultCallId(event: SessionEvent): string | undefined {
  if (event.type !== 'tool/result') return undefined
  const data = event.data as unknown as Record<string, unknown>
  const message = data.message
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return undefined
  const record = message as Record<string, unknown>
  if (typeof record.toolCallId === 'string') return record.toolCallId
  const source = record.source
  if (typeof source === 'object' && source !== null && !Array.isArray(source) && typeof (source as Record<string, unknown>).callId === 'string') return (source as Record<string, unknown>).callId as string
  const content = record.content
  if (Array.isArray(content)) {
    const block = content.find((item) => typeof item === 'object' && item !== null && !Array.isArray(item) && (item as Record<string, unknown>).type === 'tool-result' && typeof (item as Record<string, unknown>).toolCallId === 'string')
    if (block !== undefined) return (block as Record<string, unknown>).toolCallId as string
  }
  return undefined
}

export function matchTerminalResult(event: SessionEvent, pending: ReadonlyMap<string, PendingTerminalTrigger>): PendingTerminalTrigger | undefined {
  const callId = toolResultCallId(event)
  return callId === undefined ? undefined : pending.get(callId)
}

export function turnTriggerKey(sessionId: string, turn: number, templateVersion: string): string {
  return `${sessionId}:turn:${turn}:${templateVersion}`
}
