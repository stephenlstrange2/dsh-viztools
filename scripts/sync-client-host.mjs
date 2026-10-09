import { copyFile, mkdir } from 'node:fs/promises'

const root = new URL('..', import.meta.url)
const target = new URL('../client-host/', import.meta.url)
await mkdir(target, { recursive: true })
for (const file of ['client.js', 'client.js.map']) {
  await copyFile(new URL(`../lib/${file}`, import.meta.url), new URL(`../client-host/${file}`, import.meta.url))
}
