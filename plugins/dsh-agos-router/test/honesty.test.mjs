// C5 — a text-only trial must never be recorded or displayed as a successful real
// repository execution.
//
// The failure this guards against is not a crash; it is a lie that reads like data.
// Three roles stream text, every turn returns ok:true, and somewhere downstream that
// becomes "the run succeeded". The turn's ok means "the stream completed", nothing
// more: no repository was touched, no session model changed, no tool ran.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DISPATCH_COPY,
  DISPATCH_NO_TOOLS_COPY,
  buildDispatchRecord,
  dispatchTeam,
} from '../lib/dispatch.js'
import { LIVE_DISPATCH_OFF_COPY } from '../lib/assemble.js'
import { appendLine, foldLedger, listRoutes, readLedgerLines, summarizeOutcomes } from '../lib/ledger.js'
import { allocationStateFromLedger } from '../lib/assemble.js'
import { coverageGrid, deriveRouteRows } from '../lib/outcomes.js'
import { mintAssembleId, mintDecisionId } from '../lib/ids.js'

const DEC = mintDecisionId()
const TEAM = {
  id: mintAssembleId(),
  ref: DEC,
  roles: [
    { role: 'planner', model: 'glm-5.2' },
    { role: 'implementer', model: 'qwen3.8-max' },
    { role: 'reviewer', model: 'minimax-m3' },
  ],
}

/** The most dangerous case: everything "worked". Every role streamed text successfully. */
const allRolesSucceed = async ({ role }) => `${role} 完成了`

test('a fully successful text-only trial is recorded as text-only, not as a repository run', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'agos-honesty-'))
  const file = join(dir, 'route-outcome.jsonl')
  appendLine(file, {
    id: DEC, ts: 1788000000000, taskType: 'coding', role: 'implementer', label: 'coding',
    pick: 'qwen3.8-max', candidates: ['qwen3.8-max', 'minimax-m3'], source: 'selector', outcome: null,
  })

  const result = await dispatchTeam(TEAM, { confirm: true, task: '给 README 补一段部署说明' }, {
    append: (row) => appendLine(file, row),
    readRows: () => readLedgerLines(file),
    streamRole: allRolesSucceed,
  })
  const record = result.dispatch

  // Every turn "succeeded".
  assert.equal(record.turns.length, 3)
  assert.ok(record.turns.every((turn) => turn.ok === true), 'precondition: all three roles streamed fine')

  // The row says, in itself, what kind of run this was.
  assert.equal(record.execution, 'text-only')
  assert.equal(record.repoModified, false)
  assert.equal(record.sessionSwitched, false)
  assert.equal(record.tools, DISPATCH_NO_TOOLS_COPY)
  assert.equal(record.note, DISPATCH_COPY)
  assert.equal(record.live, LIVE_DISPATCH_OFF_COPY)

  // And it claims no result. Three streams completing is not an outcome.
  assert.equal(record.outcome, null)
  assert.equal(result.outcome, null)
  assert.equal(record.verdict, null, 'no parseable 判定 line was produced')
  assert.equal(record.verdictFed, false)
  assert.equal(readLedgerLines(file).some((row) => row.kind === 'outcome'), false,
    'a text-only trial with three ok turns booked a win')

  // Nothing in the row may read as a repository execution.
  const text = JSON.stringify(record)
  for (const claim of ['repoModified":true', '"execution":"repo', 'sessionSwitched":true']) {
    assert.equal(text.includes(claim), false, `row claims ${claim}`)
  }
  t.diagnostic(`trial ${record.id} recorded as ${record.execution}`)
})

test('turn success never becomes a decision outcome, a posterior observation, or a filled cell', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agos-honesty-fold-'))
  const file = join(dir, 'route-outcome.jsonl')
  const decision = {
    id: DEC, ts: 1788000000000, taskType: 'coding', role: 'implementer', label: 'coding',
    pick: 'qwen3.8-max', candidates: ['qwen3.8-max', 'minimax-m3'], source: 'selector', outcome: null,
  }
  appendLine(file, decision)
  await dispatchTeam(TEAM, { confirm: true, task: 'x' }, {
    append: (row) => appendLine(file, row),
    readRows: () => readLedgerLines(file),
    streamRole: allRolesSucceed,
  })

  const rows = readLedgerLines(file)
  const folded = foldLedger(rows)

  // The trial is not a decision, and the decision it belongs to is still unjudged.
  assert.equal(folded.decisions.length, 1)
  assert.equal(folded.decisions[0].outcome, null)
  assert.equal(folded.dispatch.kind, 'dispatch')

  // Nothing enters the Beta posterior from a text-only trial.
  assert.deepEqual(allocationStateFromLedger(rows), [])

  // The console still shows it as pending, not as a success.
  const listed = listRoutes(file, 50)
  assert.equal(listed.stats.filled, 0)
  assert.equal(listed.stats.pending, 1)
  assert.equal(summarizeOutcomes(folded.decisions).filled, 0)

  // The five-source derivation records the turns as `route` rows whose taskType is
  // the role, with no measured duration. They must never be counted as `fleet`
  // rows — that kind means a real worker actually ran something.
  const derived = deriveRouteRows(rows)
  const turnRows = derived.filter((row) => String(row.ref).includes('#'))
  assert.equal(turnRows.length, 3)
  assert.ok(turnRows.every((row) => row.kind === 'route'), 'a trial turn was promoted to another source kind')
  assert.ok(turnRows.every((row) => row.ms === null), 'a text-only turn must not report an execution time')
  assert.deepEqual(turnRows.map((row) => row.taskType).sort(), ['implementer', 'planner', 'reviewer'])
  assert.equal(coverageGrid(derived).byKind.fleet, undefined)
})

test('the honesty fields are on the record itself, so no display layer has to infer them', () => {
  // Built directly, with no deps at all: an integrator that only calls
  // buildDispatchRecord still gets an honest row.
  const bare = buildDispatchRecord(TEAM, [{ role: 'planner', model: 'glm-5.2', ok: true, text: 'p' }], '任务')
  assert.equal(bare.execution, 'text-only')
  assert.equal(bare.repoModified, false)
  assert.equal(bare.dispatched, true, 'the trial did happen — that field is about the trial, not the repo')
  assert.equal(bare.outcome, null)
  assert.equal(bare.tools, DISPATCH_NO_TOOLS_COPY)
  assert.equal(DISPATCH_NO_TOOLS_COPY, '三角色只出文本，不改仓库')
})

test('even a passing reviewer verdict books a judgement, never a repository execution', async () => {
  const decision = {
    id: DEC, ts: 1788000000000, taskType: 'coding', role: 'implementer', label: 'coding',
    pick: 'qwen3.8-max', candidates: ['qwen3.8-max', 'minimax-m3', 'glm-5.2'], source: 'selector', outcome: null,
  }
  const rows = [decision]
  const appended = []
  const result = await dispatchTeam(TEAM, { confirm: true, task: 'x' }, {
    readRows: () => [...rows, ...appended],
    append: (row) => appended.push(row),
    streamRole: async ({ role }) => (role === 'reviewer' ? '判定：通过\n覆盖了要求。' : `${role} 文本`),
  })

  assert.equal(result.dispatch.verdictFed, true)
  const outcome = appended.find((row) => row.kind === 'outcome')
  // The booked row is explicitly a reviewer's opinion. It is not evidence that code
  // ran, and its source says so.
  assert.equal(outcome.source, 'reviewer-verdict')
  assert.equal(outcome.judge, 'minimax-m3')
  assert.equal(outcome.judged, 'qwen3.8-max')
  assert.equal(result.dispatch.execution, 'text-only')
  assert.equal(result.dispatch.repoModified, false)
  assert.equal(result.dispatch.outcome, null, 'the trial row itself still claims no result')
})
