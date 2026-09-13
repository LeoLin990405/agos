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
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ARTIFACT_DIR, redact } from '../../scripts/host-integration/host-env.mjs';
import { createHarness } from './harness.mjs';
import { scenarios } from './scenarios.mjs';
import { buildLayerResult, sha256File, writeLayerResult } from './layer-result.mjs';
import { recoveryArgvForScenario } from './recovery-argv.mjs';

const onlyArg = process.argv.indexOf('--only')
const only = onlyArg === -1 ? undefined : new Set(process.argv[onlyArg + 1].split(','))
const selected = scenarios.filter((scenario) => only === undefined || only.has(scenario.id))

// Where the `agos-acceptance/integration-layer@1` document goes. Defaults to
// the artifact directory so a plain run still produces one; the unified matrix
// passes its own per-round log directory.
function parseLogdir(argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--logdir' || arg.startsWith('--logdir=')) {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[++i]
      if (value === undefined || value === '') throw new Error('--logdir requires a path')
      return path.resolve(value)
    }
  }
  return ARTIFACT_DIR
}
const logDir = parseLogdir(process.argv)
const startedAt = new Date().toISOString()

const results = []
let harness
let failed = 0
/** Set when bring-up failed for a reason this machine cannot fix by retrying. */
let bringUpBlocked

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

/**
 * A copyable command that would unblock this machine.
 *
 * The contract asks for one whenever the verdict is `blocked`, and the useful
 * answer depends on WHICH component was missing — `resolveDshBin`,
 * `resolvePlaywrightModule` and `resolveBrowserExecutable` all tag their
 * refusals with a `reason`.
 */
function recoveryFor(error) {
  switch (error?.reason) {
    case 'dsh-missing':
    case 'dsh-unavailable':
      return ['env', 'AGOS_DSH_BIN=/abs/path/to/dsh', 'node', 'tests/host-integration/run.mjs']
    case 'browser-missing':
    case 'browser-unavailable':
      return ['env', 'AGOS_BROWSER_EXECUTABLE=/abs/path/to/chrome', 'node', 'tests/host-integration/run.mjs']
    case 'playwright-missing':
    case 'playwright-unavailable':
    case 'playwright-live-profile':
      return ['env', 'AGOS_PLAYWRIGHT_MODULE=/abs/path/to/playwright-core/index.js', 'node', 'tests/host-integration/run.mjs']
    default:
      return ['node', 'tests/host-integration/run.mjs']
  }
}

/**
 * A scenario-level block means bring-up succeeded but one named layer could
 * not be observed. Preserve that distinction in the layer document and give
 * an operator an argv that can be copied to retry exactly the uncovered case.
 */
export function recoveryForScenario(blocks, argv = process.argv) {
  const id = blocks.find((entry) => typeof entry.scenarioId === 'string')?.scenarioId
  return recoveryArgvForScenario(argv, id)
}
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
      ...(blocks.length > 0 ? { blocked: blocks.map(({ layer, reason }) => ({ layer, reason })) } : {}),
      ...(error !== undefined ? { error } : {}),
      ...(screenshot !== undefined ? { screenshot } : {}),
    })
    harness.log(`   → ${status.toUpperCase()} in ${Date.now() - started}ms`)
  }
} catch (caught) {
  // A bring-up that failed because this MACHINE cannot host the suite — no
  // Chrome, no playwright-core in the repo's own tree, no dsh CLI — is
  // `blocked`, not `fail`. `IntegrationBlocked` carries `blocked === true`
  // precisely so the two can be told apart here, and conflating them would
  // report an absent optional component as a product defect (and would have
  // been the outcome on every machine laid out differently from this one).
  const isBlocked = caught?.blocked === true
  if (!isBlocked) failed += 1
  results.push({
    id: 'harness',
    title: 'harness bring-up',
    exercises: { host: 'real', browser: 'real', transport: 'real', store: 'real' },
    status: isBlocked ? 'blocked' : 'fail',
    ...(isBlocked
      ? { blocked: [{ layer: `host-browser bring-up (${caught.reason ?? 'unavailable'})`, reason: redact(String(caught.message)) }] }
      : {}),
    error: redact(String(caught?.stack ?? caught?.message ?? caught)),
    checks: [],
  })
  bringUpBlocked = isBlocked ? caught : undefined
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
  const resultsPath = path.join(ARTIFACT_DIR, 'results.json')
  await writeFile(resultsPath, JSON.stringify(summary, undefined, 2) + '\n')

  // The `agos-acceptance/integration-layer@1` document for this layer. Written
  // whatever the outcome, because a `blocked` or `fail` verdict is exactly the
  // case the unified matrix must be able to read rather than infer.
  const provenance = harness?.provenance ?? {}
  const moduleProvenance = []
  if (provenance.playwright !== undefined) {
    const pkg = path.join(provenance.playwright.modulePath.split('playwright-core')[0], 'playwright-core', 'package.json')
    const version = await readFile(pkg, 'utf8').then((text) => JSON.parse(text).version).catch(() => null)
    moduleProvenance.push({
      specifier: 'playwright-core',
      resolvedPath: provenance.playwright.modulePath,
      version,
      sha256: (await sha256File(provenance.playwright.modulePath)) ?? null,
      origin: provenance.playwright.source === 'explicit' ? 'explicit' : 'repo-tree',
      originNote: `resolved via ${provenance.playwright.source}; the harness never borrows ~/.dsh`,
    })
  }
  if (provenance.browser !== undefined) {
    moduleProvenance.push({
      specifier: 'chrome/chromium executable',
      resolvedPath: provenance.browser.executablePath,
      version: provenance.browserVersion ?? null,
      // Deliberately not hashed: this is a multi-hundred-megabyte OS-installed
      // application bundle, not a repository module. A guessed hash is worse
      // than an absent one, so it is absent and says why.
      sha256: null,
      origin: 'os-installed',
      originNote: `found by ${provenance.browser.source}; nothing is ever downloaded`,
    })
  }
  if (provenance.dsh !== undefined) {
    moduleProvenance.push({
      specifier: 'dsh CLI',
      resolvedPath: provenance.dsh.path,
      version: null,
      sha256: (await sha256File(provenance.dsh.path)) ?? null,
      origin: 'os-installed',
      originNote: `found by ${provenance.dsh.source}`,
    })
  }
  if (provenance.identity !== undefined) {
    moduleProvenance.push({
      specifier: 'process-identity backend',
      resolvedPath: provenance.identity.backend,
      version: null,
      sha256: null,
      origin: 'os',
      originNote: provenance.identity.ok
        ? 'spawned processes can be recorded and reaped'
        : 'NO backend: spawned processes cannot be recorded or reaped on this machine',
    })
  }

  const counts = {
    pass: summary.passed, fail: summary.failed, skip: summary.skipped, blocked: summary.blocked,
  }
  const scenarioBlocks = results.flatMap((result) => (result.blocked ?? [])
    .map((entry) => ({ ...entry, scenarioId: result.id })))
  const exitCode = failed === 0 ? 0 : 1
  await mkdir(logDir, { recursive: true })
  const layer = await buildLayerResult({
    counts,
    command: [process.execPath, ...process.argv.slice(1)],
    startedAt,
    endedAt: new Date().toISOString(),
    exitCode,
    repoRoot: REPO_ROOT,
    moduleProvenance,
    logFiles: await (async () => {
      // Evidence must live in --logdir. Hashing ARTIFACT_DIR (a shared, next-run-
      // overwritten folder) makes an old host-browser.json's logs[] unverifiable.
      const names = ['results.json', 'run.log', 'host.log']
      const copied = []
      for (const name of names) {
        const src = path.join(ARTIFACT_DIR, name)
        const dest = path.join(logDir, name)
        const bytes = await readFile(src).catch(() => undefined)
        if (bytes === undefined) continue
        if (dest !== src) await writeFile(dest, bytes)
        copied.push(dest)
      }
      return copied
    })(),
    blockedReason: bringUpBlocked === undefined
      ? (summary.blocked > 0
        ? scenarioBlocks.map((entry) => `${entry.scenarioId}: ${entry.layer}: ${entry.reason}`).join('; ')
        : null)
      : redact(String(bringUpBlocked.message)),
    recoveryCommand: bringUpBlocked === undefined
      ? (summary.blocked > 0 ? recoveryForScenario(scenarioBlocks) : null)
      : recoveryFor(bringUpBlocked),
    uncoveredLayers: summary.uncoveredLayers,
    scenarios: results.map((result) => ({ id: result.id, status: result.status, ms: result.ms ?? null })),
  })
  const written = await writeLayerResult(logDir, layer)
  console.log(`\nlayer result: ${written.file} → verdict=${layer.verdict} `
    + `(pass=${counts.pass} fail=${counts.fail} blocked=${counts.blocked} skip=${counts.skip})`)

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
