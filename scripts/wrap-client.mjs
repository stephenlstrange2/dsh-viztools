import { readFile, writeFile } from 'node:fs/promises'

const path = new URL('../lib/client.js', import.meta.url)
const source = await readFile(path, 'utf8')
const importPattern = /^import \{([^}]+)\} from "([^"]+)";\n/gm
const bindings = []
let body = source.replace(importPattern, (_match, names, request) => {
  for (const entry of names.split(',')) {
    const [imported, local] = entry.trim().split(/\s+as\s+/)
    bindings.push(`const ${local ?? imported} = require(${JSON.stringify(request)}).${imported};`)
  }
  return ''
})
if (/^import\s/m.test(body)) throw new Error('wrap-client: unsupported import form remains in lib/client.js')
body = body.replace(/^\/\/# sourceMappingURL=.*\n?/m, '')
body = body.replace(/^export \{([^}]+)\};\n?$/m, (_match, names) => {
  const exports = names.split(',').map((entry) => entry.trim()).filter(Boolean)
  return exports.map((entry) => {
    const [local, exported] = entry.split(/\s+as\s+/)
    return `exports.${exported ?? local} = ${local};`
  }).join('\n')
})
const wrapped = `window.__ModuleLoader__.load({\n  id: "dsh-viztools-client-host",\n  factory: (require) => {\n    var module = { exports: {} };\n    var exports = module.exports;\n    ${bindings.join('\n    ')}\n${body.split('\n').map((line) => `    ${line}`).join('\n')}\n    return module.exports;\n  },\n});\n//# sourceMappingURL=client.js.map\n`
await writeFile(path, wrapped, 'utf8')
