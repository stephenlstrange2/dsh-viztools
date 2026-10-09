import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const notebookSkill = readFileSync(new URL('../skills/explain-with-notebook/SKILL.md', import.meta.url), 'utf8')
const planSkill = readFileSync(new URL('../skills/explain-plan/SKILL.md', import.meta.url), 'utf8')

describe('notebook skill contract', () => {
  it('requires authoritative marimo_status path before edits', () => {
    expect(notebookSkill).toContain('Call `marimo_status` first')
    expect(notebookSkill).toContain('only authoritative notebook path')
    expect(notebookSkill).toContain('Never infer `.dsh/notebooks`')
    expect(planSkill).toContain('use its exact `notebook` path')
  })

  it('keeps shared notebook mutation with the root agent', () => {
    expect(notebookSkill).toContain('root agent owns notebook mutation and export')
    expect(notebookSkill).toContain('Subagents may inspect data')
    expect(planSkill).toContain('Subagents may analyze')
  })

  it('forbids success claims after failed writes or kernel checks', () => {
    expect(notebookSkill).toContain('hard failure')
    expect(notebookSkill).toContain('Do not claim the sidebar hot-reloaded or the kernel is healthy')
  })
})
