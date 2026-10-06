import { randomBytes } from 'node:crypto'
import { createConnection, createServer } from 'node:net'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, type ChildProcess } from 'node:child_process'
import type { ResolvedConfig } from './config.js'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const NOTEBOOK_TEMPLATE = `import marimo\n\n__generated_with = "0.25.1"\napp = marimo.App(width="medium")\n\n\n@app.cell\ndef _():\n    import marimo as mo\n    return (mo,)\n\n\n@app.cell\ndef _(mo):\n    mo.md("""# DSH explanation\n\nThis live notebook is managed by **dsh-viztools**. Ask the agent to explain a run or add a visualization.\n""")\n    return\n\n\nif __name__ == "__main__":\n    app.run()\n`

export interface RuntimeStatus {
  readonly cwd: string
  readonly notebook: string
  readonly browserUrl: string
  readonly mcpUrl?: string
  readonly port: number
  readonly pid: number
  readonly marimoVersion: string
}

function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

export function workspacePath(root: string, value: string, label: string): string {
  const candidate = resolve(root, value)
  if (!within(root, candidate)) {
    throw new Error(`${label} must stay inside the workspace: ${candidate}`)
  }
  return candidate
}

async function run(command: string, args: readonly string[], cwd: string, timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env: env === undefined ? process.env : { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`${command} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    timer.unref()
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) resolvePromise()
      else reject(new Error(`${command} exited with ${code ?? signal}: ${Buffer.concat(stderr).toString('utf8').trim() || Buffer.concat(stdout).toString('utf8').trim()}`))
    })
  })
}

async function freePort(): Promise<number> {
  return await new Promise<number>((resolvePromise, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        reject(new Error('failed to allocate a loopback port'))
        return
      }
      const port = address.port
      server.close((error) => error ? reject(error) : resolvePromise(port))
    })
  })
}

async function waitForPort(port: number, child: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`marimo exited before becoming ready (code ${child.exitCode})`)
    const ready = await new Promise<boolean>((resolvePromise) => {
      const socket = createConnection({ host: '127.0.0.1', port })
      socket.setTimeout(250)
      socket.once('connect', () => { socket.destroy(); resolvePromise(true) })
      socket.once('timeout', () => { socket.destroy(); resolvePromise(false) })
      socket.once('error', () => resolvePromise(false))
    })
    if (ready) return
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
  }
  throw new Error(`marimo did not listen on port ${port} within ${timeoutMs}ms`)
}

export class MarimoRuntime {
  readonly cwd: string
  readonly notebook: string
  readonly environmentDir: string
  readonly exportPath: string
  private child: ChildProcess | undefined
  private current: RuntimeStatus | undefined

  constructor(private readonly config: ResolvedConfig) {
    this.cwd = resolve(config.cwd || process.cwd())
    this.notebook = workspacePath(this.cwd, config.notebook, 'notebook')
    this.environmentDir = workspacePath(this.cwd, config.environmentDir, 'environmentDir')
    this.exportPath = workspacePath(this.cwd, config.exportPath, 'exportPath')
  }

  status(): RuntimeStatus {
    if (this.current === undefined) throw new Error('marimo is not running')
    return this.current
  }

  private python(): string {
    return process.platform === 'win32'
      ? join(this.environmentDir, '.venv', 'Scripts', 'python.exe')
      : join(this.environmentDir, '.venv', 'bin', 'python')
  }

  private async prepareEnvironment(): Promise<void> {
    await mkdir(this.environmentDir, { recursive: true })
    const marker = join(this.environmentDir, 'runtime.json')
    const wanted = JSON.stringify({ marimo: this.config.marimoVersion, python: this.config.pythonVersion, loader: 1 })
    let installed = ''
    try { installed = await readFile(marker, 'utf8') } catch { /* first run */ }
    if (installed === wanted) return

    await run(this.config.uvCommand, ['venv', '--clear', '--python', this.config.pythonVersion, join(this.environmentDir, '.venv')], this.cwd, this.config.startupTimeoutMs)
    await run(this.config.uvCommand, [
      'pip', 'install', '--python', this.python(),
      `marimo[mcp]==${this.config.marimoVersion}`,
      'zstandard>=0.23,<1',
    ], this.cwd, this.config.startupTimeoutMs)
    await writeFile(marker, wanted, 'utf8')
  }

  async start(): Promise<RuntimeStatus> {
    if (this.current !== undefined) return this.current
    await this.prepareEnvironment()
    await mkdir(dirname(this.notebook), { recursive: true })
    try { await readFile(this.notebook, 'utf8') } catch { await writeFile(this.notebook, NOTEBOOK_TEMPLATE, 'utf8') }

    const root = await realpath(this.cwd)
    const notebookParent = await realpath(dirname(this.notebook))
    if (!within(root, notebookParent)) throw new Error('notebook parent resolves outside the workspace')

    const port = await freePort()
    const token = randomBytes(32).toString('base64url')
    const args = [
      '-m', 'marimo', 'edit', this.notebook,
      '--headless', '--host', '127.0.0.1', '--port', String(port),
      '--token-password', token, '--skip-update-check', '--watch',
      ...(this.config.mcpCodeMode ? ['--mcp=code-mode'] : []),
    ]
    const pythonPath = join(PACKAGE_ROOT, 'python')
    const child = spawn(this.python(), args, {
      cwd: this.cwd,
      env: { ...process.env, PYTHONPATH: process.env.PYTHONPATH ? `${pythonPath}${delimiter}${process.env.PYTHONPATH}` : pythonPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child
    let startupError = ''
    child.stderr?.on('data', (chunk: Buffer) => { startupError = `${startupError}${chunk.toString('utf8')}`.slice(-16_384) })
    child.once('exit', () => { this.current = undefined })
    try {
      await waitForPort(port, child, this.config.startupTimeoutMs)
    } catch (error) {
      child.kill('SIGKILL')
      throw new Error(`failed to start marimo${startupError.trim() ? `: ${startupError.trim()}` : ''}`, { cause: error })
    }

    const query = `access_token=${encodeURIComponent(token)}`
    this.current = {
      cwd: this.cwd,
      notebook: this.notebook,
      browserUrl: `http://127.0.0.1:${port}/?${query}`,
      ...(this.config.mcpCodeMode ? { mcpUrl: `http://127.0.0.1:${port}/mcp/server?${query}` } : {}),
      port,
      pid: child.pid ?? -1,
      marimoVersion: this.config.marimoVersion,
    }
    return this.current
  }

  async exportHtml(output = this.exportPath): Promise<string> {
    const target = workspacePath(this.cwd, output, 'export path')
    await mkdir(dirname(target), { recursive: true })
    const pythonPath = join(PACKAGE_ROOT, 'python')
    await run(this.python(), ['-m', 'marimo', 'export', 'html', this.notebook, '-o', target], this.cwd, this.config.startupTimeoutMs, {
      PYTHONPATH: process.env.PYTHONPATH ? `${pythonPath}${delimiter}${process.env.PYTHONPATH}` : pythonPath,
    })
    return target
  }

  async stop(): Promise<void> {
    const child = this.child
    this.child = undefined
    this.current = undefined
    if (child === undefined || child.exitCode !== null) return
    await new Promise<void>((resolvePromise) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolvePromise() }, 2_000)
      timer.unref()
      child.once('exit', () => { clearTimeout(timer); resolvePromise() })
      child.kill('SIGTERM')
    })
  }
}
