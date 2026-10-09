export const otxToolResultContentBlock = {
  type: 'tool/result', seq: 2, time: 2_000,
  data: {
    turn: 1, step: 1,
    message: {
      role: 'tool', source: { kind: 'tool', callId: 'finalize-1' },
      content: [{ type: 'tool-result', toolCallId: 'finalize-1', isError: false, content: [{ type: 'text', text: '{"finalized":true}' }] }],
    },
  },
} as const

export const otxFinalizeCall = {
  type: 'tool/call', seq: 1, time: 1_900,
  data: { turn: 1, step: 1, callId: 'finalize-1', name: 'mcp__otx__finalize_run', arguments: '{}' },
} as const

export const otxPtcStart = {
  type: 'tool/ptc-dispatch-start', seq: 3, time: 2_100,
  data: { rootCallId: 'root', parentCallId: 'root', subCallId: 'ptc-1', name: 'mcp__otx__replay_tx_only', arguments: {} },
} as const

export const approvedGateChange = {
  type: 'viztools-gate/change', seq: 4, time: 2_200,
  data: { kind: 'approved', version: 1, planCallId: 'plan-1' },
} as const
