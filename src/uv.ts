import { spawn } from 'node:child_process'

export interface Version {
  major: number
  minor: number
  patch: number
}

export function parseUvVersion(output: string): Version {
  const match = /^uv\s+(\d+)\.(\d+)\.(\d+)/.exec(output.trim())
  if (match === null) throw new Error(`unable to parse uv version from: ${output.trim()}`)
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

export function versionAtLeast(current: Version, minimum: Version): boolean {
  return current.major > minimum.major
    || (current.major === minimum.major && (current.minor > minimum.minor
      || (current.minor === minimum.minor && current.patch >= minimum.patch)))
}

export async function probeUv(command: string, minimum: string, env: NodeJS.ProcessEnv): Promise<void> {
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(command, ['--version'], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') reject(new Error(`uv is required but was not found: ${command}`))
      else reject(error)
    })
    child.once('exit', (code) => code === 0 ? resolve(Buffer.concat(stdout).toString('utf8')) : reject(new Error(Buffer.concat(stderr).toString('utf8') || `uv --version exited ${code}`)))
  })
  const current = parseUvVersion(output)
  const required = parseUvVersion(`uv ${minimum}`)
  if (!versionAtLeast(current, required)) throw new Error(`uv ${minimum} or newer is required; found ${current.major}.${current.minor}.${current.patch}`)
}
