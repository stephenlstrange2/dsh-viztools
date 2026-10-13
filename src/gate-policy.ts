import type { RunRules } from './run-rules.js'

export const RUN_CODE = 'run_code'
export const DELEGATION_TOOLS: ReadonlySet<string> = new Set(['subagent', 'subagent_fork', 'workflow'])

export interface GatePolicyInput {
  readonly knownAgent: boolean
  /** Whether plan-first gating is configured. When false, plan approval is not required. */
  readonly planFirst?: boolean
  readonly planApproved: boolean
  /** Tools callable before plan approval. They remain subject to the deployment ceiling and run rules. */
  readonly planningTools: ReadonlySet<string>
  /**
   * Gate control tools (`exit_plan_mode`, `propose_run_rules`). They only submit something for
   * human review and cannot act on the outside world, so they are always callable.
   *
   * `run_code` is deliberately NOT a control tool: its program runs with Node APIs (fs, net,
   * child_process) limited only by the DSH sandbox, so it is governed like any other tool.
   */
  readonly controlTools?: ReadonlySet<string>
  /**
   * Whether `run_code` may run before plan approval. True only when the deployment opted in
   * (`planFirst.allowPtcTransport`) AND the session's file policy is confined (not
   * `danger-full-access`). Nested calls inside the program are still guarded one by one.
   */
  readonly ptcBeforeApproval?: boolean
  /** Explanation used when `run_code` is refused before approval. */
  readonly ptcDeniedReason?: string
  /** Whether delegation tools (`subagent`, `subagent_fork`, `workflow`) may run at all. */
  readonly delegationAllowed?: boolean
  /** Whether a deployment allowlist is configured. When false, `deploymentAllowed` is ignored. */
  readonly deploymentRestricted?: boolean
  readonly deploymentAllowed: ReadonlySet<string>
  readonly deploymentLimits: Readonly<Record<string, number>>
  readonly rules?: RunRules
  /** Saved rules could not be honoured: every governed tool is refused with this reason. */
  readonly rulesInvalid?: string
  /** Gate state cannot be interpreted at all: every tool, including control tools, is refused. */
  readonly stateBroken?: string
  /** Counts cannot be trusted: tools with limits are refused with this reason. */
  readonly countsUntrusted?: string
  /** Started (durable) plus reserved (in-flight) calls per tool. */
  readonly counts: Readonly<Record<string, number>>
  readonly tool: string
  readonly denialMessage?: string
  /** Extra explanation appended to plan refusals (for example, plan mode is unavailable). */
  readonly planNotice?: string
}

export interface GateDenial {
  readonly code: 'GATE_STATE_UNAVAILABLE' | 'GATE_STATE_MALFORMED' | 'PLAN_NOT_APPROVED' | 'DEPLOYMENT_TOOL_DENIED' | 'RUN_RULE_DENIED' | 'RUN_RULE_LIMIT' | 'RUN_RULES_INVALID' | 'COUNTS_UNTRUSTED' | 'DELEGATION_DENIED' | 'PTC_TRANSPORT_DENIED'
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
  if (input.stateBroken !== undefined) return { code: 'GATE_STATE_MALFORMED', reason: `${input.stateBroken}. Every tool is refused for this session; ask the operator to inspect the dsh-viztools state.` }
  if (input.controlTools?.has(input.tool) === true) return undefined
  if (DELEGATION_TOOLS.has(input.tool) && input.delegationAllowed !== true) {
    return { code: 'DELEGATION_DENIED', reason: `Delegation (${input.tool}) is disabled while the dsh-viztools gate governs this session: child agents would escape its plan approval and limits.` }
  }
  const planFirst = input.planFirst ?? true
  if (planFirst && !input.planApproved) {
    if (input.tool === RUN_CODE) {
      if (input.ptcBeforeApproval !== true) return { code: 'PTC_TRANSPORT_DENIED', reason: input.ptcDeniedReason ?? 'run_code is not available before plan approval.' }
    } else if (!input.planningTools.has(input.tool)) {
      const base = input.denialMessage ?? 'Plan not approved yet.'
      return { code: 'PLAN_NOT_APPROVED', reason: input.planNotice === undefined ? base : `${base} ${input.planNotice}` }
    }
  }
  // run_code included: before approval it additionally needed the opt-in above, and it is
  // never exempt from the deployment allowlist or invalid-rule refusal.
  const deploymentRestricted = input.deploymentRestricted ?? true
  if (deploymentRestricted && !input.deploymentAllowed.has(input.tool)) return { code: 'DEPLOYMENT_TOOL_DENIED', reason: `Deployment policy denies tool ${input.tool}.` }
  if (input.rulesInvalid !== undefined) {
    return { code: 'RUN_RULES_INVALID', reason: `${input.rulesInvalid}; every governed tool is refused until new run rules are approved with propose_run_rules.` }
  }
  // `allow` absent means "no session allowlist" (deployment ceiling only); an empty list denies every tool.
  if (input.rules !== undefined && (input.rules.deny.includes(input.tool) || (input.rules.allow !== undefined && !input.rules.allow.includes(input.tool)))) {
    return { code: 'RUN_RULE_DENIED', reason: `Approved run rules deny tool ${input.tool}.` }
  }
  const limit = effectiveLimit(input.tool, input.deploymentLimits, input.rules)
  if (limit !== undefined && input.countsUntrusted !== undefined) {
    return { code: 'COUNTS_UNTRUSTED', reason: `${input.countsUntrusted}; ${input.tool} has a call limit and stays refused because its count can no longer be trusted. Start a new session.` }
  }
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
