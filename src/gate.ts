import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/** Reserved enforcement entry; implemented in Roadmap Milestones 1 and 3. */
export const name = 'dsh-viztools-gate'
export const inject: string[] = []

export interface Config {
  /** Keep the entry inert until the plan-gate milestone is enabled explicitly. */
  enabled?: boolean
}

export const Config = z.object({
  enabled: z.boolean().default(false),
})

export function apply(ctx: Context, config: Config): void {
  if (config.enabled) {
    ctx.logger.warn('dsh-viztools/gate is reserved; plan-gate enforcement is not implemented in this release')
  }
}

apply.Config = Config
