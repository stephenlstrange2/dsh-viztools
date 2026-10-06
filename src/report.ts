import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/** Reserved automatic-report entry; implemented in Roadmap Milestone 4. */
export const name = 'dsh-viztools-report'
export const inject: string[] = []

export interface Config {
  /** Keep the entry inert until automatic report generation is enabled explicitly. */
  enabled?: boolean
}

export const Config = z.object({
  enabled: z.boolean().default(false),
})

export function apply(ctx: Context, config: Config): void {
  if (config.enabled) {
    ctx.logger.warn('dsh-viztools/report is reserved; automatic reporting is not implemented in this release')
  }
}

apply.Config = Config
