import type { RunRules } from './run-rules.js'

export interface GatePolicyInput {
  readonly knownAgent: boolean
  readonly planApproved: boolean
  readonly planningTools: ReadonlySet<string>
  readonly deploymentAllowed: ReadonlySet<string>
  readonly deploymentLimits: Readonly<Record<string, number>>
  readonly rules?: RunRules
  readonly counts: Readonly<Record<string, number>>
  readonly tool: string
}

export interface GateDenial {
  readonly code: 'GATE_STATE_UNAVAILABLE' | 'PLAN_NOT_APPROVED' | 'DEPLOYMENT_TOOL_DENIED' | 'RUN_RULE_DENIED' | 'RUN_RULE_LIMIT'
  readonly reason: string
  readonly count?: number
  readonly limit?: number
}

export function decideTool(input: GatePolicyInput): GateDenial | undefined {
  if (!input.knownAgent) return { code: 'GATE_STATE_UNAVAILABLE', reason: 'Plan gate state is unavailable; refusing tool execution.' }
  if (!input.planApproved && !input.planningTools.has(input.tool)) return { code: 'PLAN_NOT_APPROVED', reason: 'Plan not approved yet.' }
  if (input.planningTools.has(input.tool)) return undefined
  if (!input.deploymentAllowed.has(input.tool)) return { code: 'DEPLOYMENT_TOOL_DENIED', reason: `Deployment policy denies tool ${input.tool}.` }
  if (input.rules !== undefined && (input.rules.deny.includes(input.tool) || (input.rules.allow.length > 0 && !input.rules.allow.includes(input.tool)))) {
    return { code: 'RUN_RULE_DENIED', reason: `Approved run rules deny tool ${input.tool}.` }
  }
  const deploymentLimit = input.deploymentLimits[input.tool]
  const sessionLimit = input.rules?.limits[input.tool]
  const limit = deploymentLimit === undefined ? sessionLimit : sessionLimit === undefined ? deploymentLimit : Math.min(deploymentLimit, sessionLimit)
  const count = input.counts[input.tool] ?? 0
  if (limit !== undefined && count >= limit) return { code: 'RUN_RULE_LIMIT', reason: `Approved run rule limit reached for ${input.tool}: ${limit}.`, count, limit }
  return undefined
}

export function expandPatterns(patterns: readonly string[], registryTools: readonly string[], deploymentAllowed: ReadonlySet<string>): string[] {
  const expanded = new Set<string>()
  for (const pattern of patterns) {
    const matches = pattern.endsWith('*') ? registryTools.filter((tool) => tool.startsWith(pattern.slice(0, -1))) : registryTools.filter((tool) => tool === pattern)
    if (matches.length === 0) throw new Error(`tool pattern matches no registered tools: ${pattern}`)
    const forbidden = matches.filter((tool) => !deploymentAllowed.has(tool))
    if (forbidden.length > 0) throw new Error(`tool pattern ${pattern} also matches deployment-denied tools: ${forbidden.join(', ')}`)
    for (const tool of matches) expanded.add(tool)
  }
  return [...expanded].sort()
}
