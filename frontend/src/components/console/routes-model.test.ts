import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  formatCoverage,
  outcomeLabel,
  parseRoutesPayload,
  ROUTES_READY_COPY,
  routesTierNote,
  ruleReasonCopy,
} from './routes-model.ts'

test('parseRoutesPayload rejects a missing stats block', () => {
  assert.throws(() => parseRoutesPayload({ decisions: [] }), /缺少/)
  const ok = parseRoutesPayload({
    decisions: [{ pick: 'qwen3.8-max', outcome: null }],
    stats: { total: 3, filled: 0, pending: 3, cells: 1, window: 1, limit: 50 },
  })
  assert.equal(ok.stats.pending, 3)
})

test('null outcome is pending, never success or failure', () => {
  assert.equal(outcomeLabel(null), 'pending')
  assert.equal(outcomeLabel(undefined), 'pending')
  assert.equal(outcomeLabel('ok'), 'filled')
  assert.equal(
    formatCoverage({ total: 3, filled: 1, pending: 2, cells: 2, window: 2 }),
    '显示最近 2 条，台账共 3 条 · 已回填结果 1 条 · 覆盖 2 个 (角色, 模型) 格',
  )
})

test('success-only copy is not the error or empty-state string', () => {
  assert.equal(ROUTES_READY_COPY, '路由档位')
  assert.notEqual(ROUTES_READY_COPY, '待回填')
})

test('every selector reason has Chinese copy; unknown ones render nothing', () => {
  // selector.js:88-96 的 reasonRank 全集。少一个就会把机器 token 吐上屏。
  for (const reason of [
    'gate-verified', 'gate-failed', 'forced-category',
    'empty', 'singleton', 'quorum', 'split', 'no-signal',
  ]) {
    const copy = ruleReasonCopy(reason)
    assert.ok(copy !== undefined, reason + ' 没有中文文案')
    assert.doesNotMatch(copy, /[a-z]/, reason + ' 的文案里还带着英文 token')
  }
  assert.equal(ruleReasonCopy('no-signal'), '没有可聚的判断')
  assert.equal(ruleReasonCopy('split'), '聚类分裂')
  assert.notEqual(ruleReasonCopy('no-signal'), ruleReasonCopy('split'))
  // 兜底不再直通:认不出的 reason 不渲染。
  assert.equal(ruleReasonCopy('brand-new-reason'), undefined)
  assert.equal(ruleReasonCopy(undefined), undefined)
})

test('页头这句由同屏 decisions 算出，不是无条件断言 (TASK-019 验收 P1)', () => {
  const note = (reasons: string[]): string => routesTierNote(reasons.map((reason) => ({ rule: { reason } })))
  // 台账里有 split 时，页头不得再说「不是一场分歧」这类否认。
  const withSplit = note(['gate-verified', 'gate-verified', 'split', 'quorum'])
  assert.match(withSplit, /聚类分裂 1 条/)
  assert.match(withSplit, /多数一致 1 条/)
  assert.doesNotMatch(withSplit, /不是一场分歧/)
  // 页头点名的值必须真的在这批里 —— no-signal 一条没有就不能出现这个词。
  assert.doesNotMatch(withSplit, /没有可聚的判断/)
  const noCluster = note(['gate-verified', 'gate-failed'])
  assert.match(noCluster, /没有一条走到聚类/)
  assert.equal(routesTierNote([]), noCluster)
})

/** 注释不算代码 —— 原来的锁把注释一起匹配，日后写一句「不要接回 ruleBadge」的警示
 *  注释就会把测试打红(2026-08-22 验收 P1 的误伤面)。 */
const stripComments = (src: string): string => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^[ \t]*\/\/.*$/gm, ' ')

test('RoutesView does not mount three-tier badges (TASK-019 W7 a)', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const view = stripComments(readFileSync(join(here, 'RoutesView.tsx'), 'utf8'))
  const model = stripComments(readFileSync(join(here, 'routes-model.ts'), 'utf8'))
  // ⚠️ 原来这 5 条只锁「单行字面量 <Badge …>TRUST</Badge>」。实测逃逸三条:
  //   {row.rule?.outcome} 数据驱动 / JSX 折成多行 / helper 改名 tierBadge
  //   —— 三档全都能无声长回来而测试照绿(2026-08-22 验收 P1)。下面按形态锁,不按写法锁。
  // a. 三档的字面值，出现在视图里就红,不管在第几行、包在什么标签里。
  for (const tier of ['TRUST_SPOT_CHECK', 'TRUST', 'ESCALATE', '抽检', '升级']) {
    assert.doesNotMatch(view, new RegExp(tier), '三档字面值 ' + tier + ' 回到了 RoutesView')
  }
  // b. 数据驱动接回:直接渲染台账里已有的 rule.outcome。
  assert.doesNotMatch(view, /rule\s*\??\.\s*outcome/, 'rule.outcome 被接回渲染')
  // c. helper 改名逃逸:model 里任何名字带 Badge 的导出都算三档 helper 复活。
  assert.doesNotMatch(model, /(?:function|const|let|var)\s+\w*[Bb]adge/, 'model 里出现了 *Badge helper')
  assert.doesNotMatch(view, /\w*[Bb]adge\s*\(/, 'RoutesView 在调用某个 *Badge helper')
  // d. 页头必须是算出来的，不是常量。
  assert.match(view, /routesTierNote\(payload\.decisions\)/)
})
