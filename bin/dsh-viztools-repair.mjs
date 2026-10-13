#!/usr/bin/env node
// Repair DSH session logs that contain legacy, non-ignorable viztools-* events so DSH
// 0.2.0-rc.2 can reopen them. Stop every DSH process using the home first.
import { repairSessions } from '../lib/repair.js'

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const value = (name) => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : undefined }
const values = (name) => argv.flatMap((arg, index) => (arg === name ? [argv[index + 1]] : []))

if (flag('--help') || flag('-h') || value('--dsh-home') === undefined || value('--workspace') === undefined) {
  console.log(`Usage: dsh-viztools-repair --dsh-home <dir> --workspace <console-cwd> [--state-dir .dsh/viztools/state] [--session <id>]... [--dry-run] [--zstd <path>]

Marks legacy viztools-* events ignorable in place (sequence numbers are preserved), exports their
state into the plugin sidecar, and backs up every changed log as <log>.viztools-backup-<time>.
Use --dry-run first. Stop all DSH processes that use this DSH home before repairing.`)
  process.exit(value('--dsh-home') === undefined || value('--workspace') === undefined ? 2 : 0)
}

const results = repairSessions({
  dshHome: value('--dsh-home'),
  workspace: value('--workspace'),
  ...(value('--state-dir') === undefined ? {} : { stateDir: value('--state-dir') }),
  ...(values('--session').length === 0 ? {} : { sessions: values('--session') }),
  ...(value('--zstd') === undefined ? {} : { zstd: value('--zstd') }),
  dryRun: flag('--dry-run'),
})
for (const result of results) {
  if (result.action === 'clean') continue
  const exported = `gate=${result.exported.gate} report=${result.exported.report}${result.exported.skipped ? ` (${result.exported.skipped})` : ''}`
  console.log(`${result.action.padEnd(13)} ${result.sessionId}  legacy=${result.legacyEvents}  ${exported}${result.backup ? `  backup=${result.backup}` : ''}${result.error ? `  error=${result.error}` : ''}`)
}
const clean = results.filter((result) => result.action === 'clean').length
console.log(`${results.length} session log(s) scanned, ${clean} clean${flag('--dry-run') ? ' (dry run: nothing written)' : ''}`)
process.exit(results.some((result) => result.action === 'failed') ? 1 : 0)
