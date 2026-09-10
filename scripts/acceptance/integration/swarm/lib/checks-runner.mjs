// Runs real swarm checks in a disposable process. A broken scheduler can retain
// timers forever; the parent can terminate this process without hanging the
// evidence-producing entry point.
import { buildChecks, runChecks } from './checks.mjs'

try {
	const specifier = process.env.AGOS_SWARM_CHECK_MODULE
	if (!specifier) throw new Error('AGOS_SWARM_CHECK_MODULE 未设置')
	const swarm = await import(specifier)
	const checkTimeoutMs = Number(process.env.AGOS_SWARM_CHECK_TIMEOUT_MS) || 5_000
	const results = await runChecks(buildChecks(swarm), { checkTimeoutMs, stopOnTimeout: true })
	process.stdout.write(JSON.stringify({ type: 'result', results }) + '\n', () => process.exit(0))
} catch (error) {
	process.stdout.write(JSON.stringify({ type: 'error', error: String(error?.stack ?? error) }) + '\n', () => process.exit(1))
}
