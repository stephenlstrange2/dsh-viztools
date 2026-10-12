import type { RunRules } from './run-rules.js'

export interface GatePolicyInput {
  readonly knownAgent: boolean
  /** Whether plan-first gating is configured. When false, plan approval is not required. */
  readonly planFirst?: boolean
  readonly planApproved: boolean
  /** Tools callable before plan approval. They remain subject to the deployment ceiling and run rules. */
  readonly planningTools: ReadonlySet<string>
  /**
   * Gate control tools (plan exit, rule proposal, PTC transport). Always callable: they
   * cannot act on the outside world themselves, and nested PTC calls are guarded individually.
   */
  readonly controlTools?: ReadonlySet<string>
  /** Whether a deployment allowlist is configured. When false, `deploymentAllowed` is ignored. */
  readonly deploymentRestricted?: boolean
  readonly deploymentAllowed: ReadonlySet<string>
  readonly deploymentLimits: Readonly<Record<string, number>>
  readonly rules?: RunRules
  /** Started (durable) plus reserved (in-flight) calls per tool. */
  readonly counts: Readonly<Record<string, number>>
  readonly tool: string
  readonly denialMessage?: string
}

export interface GateDenial {
  readonly code: 'GATE_STATE_UNAVAILABLE' | 'PLAN_NOT_APPROVED' | 'DEPLOYMENT_TOOL_DENIED' | 'RUN_RULE_DENIED' | 'RUN_RULE_LIMIT'
  readonly reason: string
  readonly count?: number
  readonly limit?: number
}

/** Effective call limit for a tool: the tighter of the deployment cap and the session rule. */
export function effectiveLimit(tool: string, deploymentLimits: Readonly<Record<string, number>>, rules: RunRules | undefined): number | undefined {
  const deploymentLimit = deploymentLimits[tool]
  const sessionLimit = rules?.limits[tool]
  return deploymentLimit === undefined ? sessionLimit : sessionLimit === undefined ? deploymentLimit : Math.min(deploymentLimit, sessionLimit)
}

export function decideTool(input: GatePolicyInput): GateDenial | undefined {
  if (!input.knownAgent) return { code: 'GATE_STATE_UNAVAILABLE', reason: 'Plan gate state is unavailable; refusing tool execution.' }
  if (input.controlTools?.has(input.tool) === true) return undefined
  const planFirst = input.planFirst ?? true
  if (planFirst && !input.planApproved && !input.planningTools.has(input.tool)) {
    return { code: 'PLAN_NOT_APPROVED', reason: input.denialMessage ?? 'Plan not approved yet.' }
  }
  const deploymentRestricted = input.deploymentRestricted ?? true
  if (deploymentRestricted && !input.deploymentAllowed.has(input.tool)) return { code: 'DEPLOYMENT_TOOL_DENIED', reason: `Deployment policy denies tool ${input.tool}.` }
  // `allow` absent means "no session allowlist" (deployment ceiling only); an empty list denies every tool.
  if (input.rules !== undefined && (input.rules.deny.includes(input.tool) || (input.rules.allow !== undefined && !input.rules.allow.includes(input.tool)))) {
    return { code: 'RUN_RULE_DENIED', reason: `Approved run rules deny tool ${input.tool}.` }
  }
  const limit = effectiveLimit(input.tool, input.deploymentLimits, input.rules)
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
