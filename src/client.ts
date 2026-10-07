import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type { ISidebarRight } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-browser/client'

export const name = 'dsh-viztools-client'
export const inject = ['connection', 'sidebarRight']

interface SidebarStatus {
  readonly browserUrl: string
  readonly notebook: string
  readonly marimoVersion: string
}

type ClientContext = Omit<Context, 'sidebarRight'> & {
  sidebarRight: ISidebarRight
}

export function parseSidebarStatus(value: unknown): SidebarStatus | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.browserUrl !== 'string' || typeof record.notebook !== 'string' || typeof record.marimoVersion !== 'string') return undefined
  return { browserUrl: record.browserUrl, notebook: record.notebook, marimoVersion: record.marimoVersion }
}

/** Resolve the secret-bearing URL over authenticated Client RPC, then open it beside the mounted Session. */
export function apply(ctx: ClientContext): void {
  let openedFor: unknown
  let generation = 0

  const open = async (): Promise<void> => {
    const sessionId = ctx.sidebarRight.mounted.getSnapshot()
    if (sessionId === undefined || sessionId === openedFor) return
    const attempt = ++generation
    const response = await globalThis.fetch('api/viztools/sidebar-url', {
      method: 'GET',
      headers: { accept: 'application/json' },
      cache: 'no-store',
    })
    if (attempt !== generation || !response.ok) return
    const value = parseSidebarStatus(await response.json())
    if (value === undefined || ctx.sidebarRight.mounted.getSnapshot() !== sessionId) return
    ctx.sidebarRight.openTab('browser', { params: { url: value.browserUrl } })
    openedFor = sessionId
  }

  const unsubscribe = ctx.sidebarRight.mounted.subscribe(() => { void open() })
  const reset = ctx.on('connection/reset', () => {
    generation += 1
    openedFor = undefined
    void open()
  })
  ctx.effect(() => {
    void open()
    return () => {
      generation += 1
      unsubscribe()
      reset()
    }
  }, 'dsh-viztools.auto-open')
}
