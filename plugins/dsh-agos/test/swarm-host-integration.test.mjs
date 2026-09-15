import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { resolveSwarmModule, describeSwarmProvenance, SWARM_OPT_IN_ENV } from '../lib/swarm-host-integration.mjs'
import { runChecks } from '../../../scripts/acceptance/integration/swarm/lib/checks.mjs'

test('directory opt-in follows ordered nested ESM exports conditions', async () => {
	const root = mkdtempSync(join(tmpdir(), 'agos-swarm-conditions-'))
	try {
		mkdirSync(join(root, 'lib'), { recursive: true })
		writeFileSync(join(root, 'package.json'), JSON.stringify({ exports: { '.': { import: { node: './lib/import.mjs' }, default: './lib/default.mjs' } } }))
		writeFileSync(join(root, 'lib/import.mjs'), 'export const selected = "import"\n')
		writeFileSync(join(root, 'lib/default.mjs'), 'export const selected = "default"\n')
		const seen = []
		const result = await resolveSwarmModule({ env: { [SWARM_OPT_IN_ENV]: root }, importer: async (specifier) => { seen.push(specifier); return { selected: 'import' } } })
		assert.equal(result.available, true)
		assert.equal(seen[0], join(root, 'lib/import.mjs'))
	} finally { rmSync(root, { recursive: true, force: true }) }
})

test('unsupported exports conditions are an explicit opt-in error', async () => {
	const root = mkdtempSync(join(tmpdir(), 'agos-swarm-unsupported-'))
	try {
		writeFileSync(join(root, 'package.json'), JSON.stringify({ exports: { '.': { browser: './browser.mjs' } } }))
		const result = await resolveSwarmModule({ env: { [SWARM_OPT_IN_ENV]: root }, importer: async () => ({}) })
		assert.equal(result.available, false)
		assert.match(result.reason, /不支持的条件/)
	} finally { rmSync(root, { recursive: true, force: true }) }
})

test('a nonmatching nested condition falls through to the next ordered condition', async () => {
	const root = mkdtempSync(join(tmpdir(), 'agos-swarm-fallback-'))
	try {
		mkdirSync(join(root, 'lib'), { recursive: true })
		writeFileSync(join(root, 'package.json'), JSON.stringify({ exports: { '.': { node: { browser: './lib/nope.mjs' }, import: './lib/import.mjs', default: './lib/default.mjs' } } }))
		const seen = []
		const result = await resolveSwarmModule({ env: { [SWARM_OPT_IN_ENV]: root }, importer: async (specifier) => { seen.push(specifier); return {} } })
		assert.equal(result.available, true)
		assert.equal(seen[0], join(root, 'lib/import.mjs'))
	} finally { rmSync(root, { recursive: true, force: true }) }
})

test('registry comparison unavailable or identical never becomes local-build', async () => {
	const root = mkdtempSync(join(tmpdir(), 'agos-swarm-provenance-'))
	try {
		mkdirSync(join(root, 'lib'), { recursive: true })
		writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture-swarm', version: '1.0.0' }))
		const entry = join(root, 'lib/index.mjs')
		writeFileSync(entry, 'import x from "@deepseek-ai/dsh-settings"\nexport { x }\n')
		const unavailable = await describeSwarmProvenance({ env: { [SWARM_OPT_IN_ENV]: entry }, registryComparison: { kind: 'registryComparison', status: 'unavailable' } })
		const identical = await describeSwarmProvenance({ env: { [SWARM_OPT_IN_ENV]: entry }, registryComparison: { kind: 'registryComparison', status: 'identical' } })
		assert.equal(unavailable.origin, 'unknown')
		assert.equal(identical.origin, 'registry')
	} finally { rmSync(root, { recursive: true, force: true }) }
})

test('a non-settling check produces a bounded failure result', async () => {
	const results = await runChecks([{ id: 'HANG', layer: 'runner', title: 'hang', fn: () => new Promise(() => {}) }], { checkTimeoutMs: 20 })
	assert.equal(results[0].status, 'fail')
	assert.match(results[0].error, /截止时间/)
})
