import type { Context } from '@deepseek-ai/cordis'

export const name = 'dsh-viztools-client'
export const inject: string[] = []

/**
 * The MVP presents the authenticated notebook URL through the model-facing
 * `marimo_status` tool. A custom automatic-open transport is intentionally not
 * installed until DSH exposes a secret-bearing Host-to-Client configuration seam.
 */
export function apply(_ctx: Context): void {}
