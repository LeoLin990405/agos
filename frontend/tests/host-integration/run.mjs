/**
 * Runner for the AgOS real-host browser integration suite (package B).
 *
 * Every scenario declares, in `exercises`, exactly which layers it really
 * drives. Nothing here is allowed to describe a component fixture or a mocked
 * transport as a real-host end-to-end test: the label travels with the result
 * into the report.
 *
 * Run:  node tests/host-integration/run.mjs [--only <id>[,<id>…]]
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ARTIFACT_DIR, redact } from '../../scripts/host-integration/host-env.mjs';
import { createHarness } from './harness.mjs';
import { scenarios } from './scenarios.mjs';

const onlyArg = process.argv.indexOf('--only')
const only = onlyArg === -1 ? undefined : new Set(process.argv[onlyArg + 1].split(','))
const selected = scenarios.filter((scenario) => only === undefined || only.has(scenario.id))

const results = []
let harness
let failed = 0

// A hard interrupt used to orphan the host process and its temp roots (it did,
// during development). Dispose on the way out; `scripts/host-integration/
// cleanup.mjs` reaps anything a SIGKILL still manages to leave behind.
let disposing = false
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    if (disposing) return
    disposing = true
    void (async () => {
      try { await harness?.dispose() } catch { /* best effort */ }
      process.exit(130)
    })()
  })
}

/**
 * Real AgOS plugins mounted into this run's throwaway profile.
 *
 * Scenario 8 is named after the turn-evidence strip, so the plugin that serves
 * it has to actually be loaded — otherwise the route 404s, `live.ts` swallows
 * it by design, the strip never renders, and a scenario that observed nothing
 * would report PASS. Mounting is not enough on its own either: `probe` makes
 * the runner re-ask the RUNNING host, and scenario 8 reports its evidence layer
 * `blocked` unless that probe came back 200.
 *
 * The entry is this repo's own plugin source (no package install, no live
 * profile): the loader turns an absolute path into a file:// URL.
 */
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const PLUGINS = [
  {
    id: 'dsh-agos',
    entry: path.join(REPO_ROOT, 'plugins', 'dsh-agos', 'lib', 'index.js'),
    probe: {
      kind: 'http',
      // GET only; 200 means the route is mounted and answering on this host.
      path: '/api/agos/turn-evidence?sessionId=probe',
    },
  },
]

try {
  harness = await createHarness({ plugins: PLUGINS })
  for (const scenario of selected) {
    const started = Date.now()
    // Fresh page per scenario: route handlers do not survive into the next one.
    await harness.resetPage()
    harness.log(`── scenario ${scenario.id}: ${scenario.title}`)
    const checks = []
    const record = (ok, detail) => {
      checks.push({ ok, detail: redact(detail) })
      harness.log(`   ${ok ? 'ok  ' : 'FAIL'} ${detail}`)
    }

    // `blocked` is a THIRD outcome, never a flavour of pass. A scenario calls it
    // when a layer it exists to cover cannot be reached in this environment (a
    // plugin route that never answered, a capability the machine lacks). The
    // point of the vocabulary: a run that could not observe the thing it is
    // named after must not be summarised as if it had observed it. Any block
    // makes the scenario `blocked` even when its other checks passed, and the
    // uncovered layer travels into the report by name.
    const blocks = []
    const blocked = (layer, reason) => {
      blocks.push({ layer, reason: redact(reason) })
      harness.log(`   BLOCKED ${layer}: ${reason}`)
    }

    let status = 'pass'
    let error
    let screenshot
    try {
      screenshot = await scenario.run({ ...harness, record, blocked })
      if (checks.length === 0 && blocks.length === 0) throw new Error('scenario recorded no checks')
      if (checks.some((check) => !check.ok)) status = 'fail'
      // A real failure outranks a block: a broken assertion is not "uncovered".
      else if (blocks.length > 0) status = 'blocked'
    } catch (caught) {
      status = 'fail'
      error = redact(String(caught?.stack ?? caught?.message ?? caught))
      try { screenshot = await harness.screenshot(`${scenario.id}-failure`) } catch { /* page may be gone */ }
    }
    if (status === 'fail') failed += 1
    results.push({
      id: scenario.id,
      title: scenario.title,
      exercises: scenario.exercises,
      status,
      ms: Date.now() - started,
      checks,
      ...(blocks.length > 0 ? { blocked: blocks } : {}),
      ...(error !== undefined ? { error } : {}),
      ...(screenshot !== undefined ? { screenshot } : {}),
    })
    harness.log(`   → ${status.toUpperCase()} in ${Date.now() - started}ms`)
  }
} catch (caught) {
  failed += 1
  results.push({
    id: 'harness',
    title: 'harness bring-up',
    exercises: { host: 'real', browser: 'real', transport: 'real', store: 'real' },
    status: 'fail',
    error: redact(String(caught?.stack ?? caught?.message ?? caught)),
    checks: [],
  })
  console.error(redact(String(caught?.stack ?? caught)))
} finally {
  const stopped = await harness?.dispose()
  const countOf = (status) => results.filter((result) => result.status === status).length
  // Scenarios selected but never reached (a bring-up failure aborts the loop):
  // reported as `skipped`, so `selected` always reconciles with the four counts.
  const reached = new Set(results.map((result) => result.id))
  const skipped = selected.filter((scenario) => !reached.has(scenario.id))
    .map((scenario) => ({
      id: scenario.id,
      title: scenario.title,
      exercises: scenario.exercises,
      status: 'skipped',
      reason: 'not reached: the run aborted before this scenario started',
      checks: [],
    }))
  results.push(...skipped)

  const summary = {
    at: new Date().toISOString(),
    pinned: 'deepseek-harness @ a66e470204 (0.1.2-rc.1)',
    selected: selected.map((scenario) => scenario.id),
    passed: countOf('pass'),
    failed: countOf('fail'),
    // Neither of these is a pass. `blocked` = the layer could not be observed
    // here; `skipped` = the scenario never ran. Kept as separate keys so a
    // reader cannot mistake either for coverage.
    blocked: countOf('blocked'),
    skipped: countOf('skipped'),
    uncoveredLayers: results.flatMap((result) => (result.blocked ?? []).map(
      (entry) => `${result.id}: ${entry.layer}`,
    )),
    hostExit: stopped ?? null,
    results,
  }
  await writeFile(
    path.join(ARTIFACT_DIR, 'results.json'),
    JSON.stringify(summary, undefined, 2) + '\n',
  )
  console.log(`\n${summary.passed} passed, ${summary.failed} failed, `
    + `${summary.blocked} blocked, ${summary.skipped} skipped (${results.length} scenarios)`)
  const LABEL = { pass: 'PASS   ', fail: 'FAIL   ', blocked: 'BLOCKED', skipped: 'SKIPPED' }
  for (const result of results) {
    console.log(`  ${LABEL[result.status] ?? result.status}  ${result.id}  ${result.title}`)
    for (const entry of result.blocked ?? []) console.log(`           ↳ 未覆盖 ${entry.layer}: ${entry.reason}`)
  }
  if (summary.uncoveredLayers.length > 0) {
    console.log(`\n未覆盖的层(${summary.uncoveredLayers.length} 项)——这些不算通过:`)
    for (const layer of summary.uncoveredLayers) console.log(`  · ${layer}`)
  }
}

process.exit(failed === 0 ? 0 : 1)
