import type { ResolvedConfig } from './config.js'

export interface LockedProfileCheck {
  readonly ok: boolean
  readonly errors: readonly string[]
}

/** Validate the runtime half of a locked-console composition before activation. */
export function checkLockedProfile(config: ResolvedConfig): LockedProfileCheck {
  const errors: string[] = []
  if (config.mode !== 'managed-readonly') errors.push('locked console requires mode: managed-readonly')
  if (config.mcpCodeMode) errors.push('locked console requires mcpCodeMode: false (managed-readonly also forces it off at runtime)')
  const root = config.managedReportRoot.replace(/\/+$/, '')
  if (!(config.notebook === root || config.notebook.startsWith(`${root}/`))) errors.push('locked console notebook must be below managedReportRoot')
  return { ok: errors.length === 0, errors }
}
