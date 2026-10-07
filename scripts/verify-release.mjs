import { readFile } from 'node:fs/promises'

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
  if (value.startsWith('--')) pairs.push([value.slice(2), all[index + 1]])
  return pairs
}, []))
const errors = []
const expectedDsh = args.dsh ?? '0.2.0-rc.2'
for (const [name, range] of Object.entries(pkg.peerDependencies ?? {})) {
  if (name.startsWith('@deepseek-ai/dsh-') && range !== expectedDsh) errors.push(`${name} peer must equal ${expectedDsh}, got ${range}`)
}
for (const required of ['./runtime', './gate', './report', './profile-check', './client']) {
  if (pkg.exports?.[required] === undefined) errors.push(`missing export ${required}`)
}
for (const file of ['README.md', 'CHANGELOG.md', 'COMPATIBILITY.md', 'THREAT_MODEL.md', 'ROADMAP.md']) {
  if (!pkg.files.includes(file)) errors.push(`package files missing ${file}`)
}
if (args.tag !== undefined) {
  if (args.tag !== `v${pkg.version}`) errors.push(`tag ${args.tag} does not match package version v${pkg.version}`)
  if (!/^1\./.test(pkg.version)) errors.push(`release workflow requires v1.x package version, got ${pkg.version}`)
}
if (errors.length) {
  console.error(errors.join('\n'))
  process.exit(1)
}
console.log(`Release verification passed for dsh-viztools ${pkg.version} / DSH ${expectedDsh}`)
