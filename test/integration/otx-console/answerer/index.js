// Test-only answerer: approves every plan review and run-rules review so the scripted run
// proceeds without a human. Never mount this outside the integration harness.
import { appendFileSync } from 'node:fs'

export const name = 'viztools-it-answerer'

export function apply(ctx) {
  ctx.on('user-questions/request', async (request) => {
    if (process.env.VIZTOOLS_IT_QUESTION_LOG) appendFileSync(process.env.VIZTOOLS_IT_QUESTION_LOG, `${JSON.stringify(request.questions.map((q) => q.id))}\n`)
    return { answers: request.questions.map((question) => ({ id: question.id, selected: [question.options?.[0]?.label ?? 'Approve'] })) }
  }, true)
}
