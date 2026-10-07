import { describe, expect, it } from 'vitest'
import { BUNDLED_REQUIREMENTS, resolveRequirementsPath, workspacePath } from '../src/runtime.js'

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

  it('resolves the default requirements lock from the package, not process cwd', () => {
    expect(resolveRequirementsPath('/home/example/workspace', 'python/requirements.lock')).toBe(BUNDLED_REQUIREMENTS)
    expect(BUNDLED_REQUIREMENTS).toMatch(/dsh-viztools\/python\/requirements\.lock$/)
  })

  it('keeps explicit requirements paths workspace-relative', () => {
    expect(resolveRequirementsPath(root, '.dsh/custom.lock')).toBe('/tmp/example-workspace/.dsh/custom.lock')
  })
})
