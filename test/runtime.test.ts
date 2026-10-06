import { describe, expect, it } from 'vitest'
import { workspacePath } from '../src/runtime.js'

const root = '/tmp/example-workspace'

describe('workspacePath', () => {
  it('accepts workspace-relative paths', () => {
    expect(workspacePath(root, '.dsh/notebook.py', 'notebook')).toBe('/tmp/example-workspace/.dsh/notebook.py')
  })

  it('rejects lexical escapes', () => {
    expect(() => workspacePath(root, '../outside.py', 'notebook')).toThrow(/inside the workspace/)
  })

  it('rejects unrelated absolute paths', () => {
    expect(() => workspacePath(root, '/etc/passwd', 'notebook')).toThrow(/inside the workspace/)
  })
})
