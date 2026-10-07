import { mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'

const root = resolve(new URL('..', import.meta.url).pathname)
const positional = process.argv.slice(2).filter((arg) => arg !== '--')
const output = resolve(root, positional[0] ?? 'dist/offline')
const cache = resolve(output, 'uv-cache')
const environment = resolve(output, 'verification-venv')
const requirements = resolve(root, 'python/requirements.lock')
const pythonVersion = process.env.PYTHON_VERSION ?? '3.12'
const uv = process.env.UV ?? 'uv'
await mkdir(cache, { recursive: true })
await rm(environment, { recursive: true, force: true })

function run(args, extraEnv = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(uv, args, { cwd: root, stdio: 'inherit', env: { ...process.env, UV_CACHE_DIR: cache, ...extraEnv } })
    child.once('error', (error) => reject(error.code === 'ENOENT' ? new Error(`uv is required but was not found: ${uv}`) : error))
    child.once('exit', (code) => code === 0 ? resolvePromise() : reject(new Error(`uv ${args.join(' ')} exited ${code}`)))
  })
}

// Populate uv's portable cache, then prove the same lock installs with networking disabled.
await run(['venv', '--python', pythonVersion, environment])
await run(['pip', 'install', '--python', environment, '--requirements', requirements, '--require-hashes'])
await rm(environment, { recursive: true, force: true })
await run(['venv', '--python', pythonVersion, environment], { UV_OFFLINE: '1' })
await run(['pip', 'install', '--python', environment, '--requirements', requirements, '--require-hashes', '--offline'], { UV_OFFLINE: '1' })
await rm(environment, { recursive: true, force: true })
console.log(`Offline uv cache verified: ${cache}`)
