/**
 * Reap anything the host-integration harness may have left behind.
 *
 * The harness disposes itself on a normal or failed run, but a hard kill
 * (SIGKILL of the runner, a crashed debug session) can orphan a host process
 * and its temp roots. Everything this script touches is identified by the
 * harness's own unique marker, so it can never match the user's real DSH:
 *
 * - processes whose argv names an `agos-host-integration-home-…` overlay file
 * - temp directories named `agos-host-integration-*` under the run tmpdir
 *
 * Run: node scripts/host-integration/cleanup.mjs
 */
import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { HARNESS_ID, removeTemp, tempRoot } from './host-env.mjs';

const run = promisify(execFile)

/** The harness marker. Never matches a plain `dsh` the user started. */
const MARKER = `${HARNESS_ID}-home-`

const listing = await run('ps', ['ax', '-o', 'pid=,command=']).catch(() => ({ stdout: '' }))
const orphans = listing.stdout.split('\n')
  .filter((line) => line.includes(MARKER) && line.includes('agos-harness-overlay.json'))
  .map((line) => ({ pid: Number(line.trim().split(/\s+/, 1)[0]), line: line.trim() }))
  .filter((entry) => Number.isInteger(entry.pid) && entry.pid !== process.pid)

for (const orphan of orphans) {
  try {
    process.kill(orphan.pid, 'SIGTERM')
    console.log(`SIGTERM → ${orphan.pid} (orphaned harness host)`)
  } catch (error) {
    console.log(`could not signal ${orphan.pid}: ${String(error)}`)
  }
}
if (orphans.length > 0) await new Promise((resolve) => { setTimeout(resolve, 2000) })
for (const orphan of orphans) {
  try { process.kill(orphan.pid, 0); process.kill(orphan.pid, 'SIGKILL'); console.log(`SIGKILL → ${orphan.pid}`) } catch { /* gone */ }
}

const entries = await readdir(tempRoot(), { withFileTypes: true }).catch(() => [])
const stale = entries.filter((entry) => entry.name.startsWith(`${HARNESS_ID}-`))
for (const entry of stale) {
  const target = path.join(tempRoot(), entry.name)
  await removeTemp(target)
  console.log(`removed ${target}`)
}

console.log(`cleanup done: ${orphans.length} process(es), ${stale.length} temp root(s)`)
