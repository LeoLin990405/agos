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

try {
  harness = await createHarness()
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
    let status = 'pass'
    let error
    let screenshot
    try {
      screenshot = await scenario.run({ ...harness, record })
      if (checks.length === 0) throw new Error('scenario recorded no checks')
      if (checks.some((check) => !check.ok)) status = 'fail'
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
  const summary = {
    at: new Date().toISOString(),
    pinned: 'deepseek-harness @ a66e470204 (0.1.2-rc.1)',
    selected: selected.map((scenario) => scenario.id),
    passed: results.filter((result) => result.status === 'pass').length,
    failed: results.filter((result) => result.status === 'fail').length,
    hostExit: stopped ?? null,
    results,
  }
  await writeFile(
    path.join(ARTIFACT_DIR, 'results.json'),
    JSON.stringify(summary, undefined, 2) + '\n',
  )
  console.log(`\n${summary.passed} passed, ${summary.failed} failed (${results.length} scenarios)`)
  for (const result of results) console.log(`  ${result.status === 'pass' ? 'PASS' : 'FAIL'}  ${result.id}  ${result.title}`)
}

process.exit(failed === 0 ? 0 : 1)
