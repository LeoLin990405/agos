import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  formatCoverage,
  outcomeLabel,
  outcomeValueCopy,
  parseRoutesPayload,
  ROUTES_READY_COPY,
  decisionReasonCopy,
  fallbackReasonCopy,
  posteriorCopy,
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
  assert.equal(outcomeValueCopy(null), '待回填')
  assert.equal(outcomeValueCopy('ok'), '成功')
  assert.equal(outcomeValueCopy('fail'), '失败')
  assert.equal(outcomeValueCopy('weird'), '已回填')
  assert.equal(
    formatCoverage({ total: 3, filled: 1, pending: 2, cells: 2, window: 2 }),
    '显示最近 2 条，台账共 3 条（模型路由 3 条）· 已回填结果 1 条 · 覆盖 2 个 (角色, 模型) 格',
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
  // W17:DispatchModal 也展示决策(影子建议),同样不得出现三档字面值与 rule.*
  const dispatchModal = stripComments(readFileSync(join(here, '..', 'fleet', 'DispatchModal.tsx'), 'utf8'))
  for (const tier of ['TRUST_SPOT_CHECK', 'TRUST', 'ESCALATE', '抽检', '升级']) {
    assert.doesNotMatch(view, new RegExp(tier), '三档字面值 ' + tier + ' 回到了 RoutesView')
    assert.doesNotMatch(dispatchModal, new RegExp(tier), '三档字面值 ' + tier + ' 出现在 DispatchModal')
  }
  assert.doesNotMatch(dispatchModal, /rule\s*\??\.\s*(outcome|reason|pick)/, 'DispatchModal 渲染了 rule.*')
  // b. 数据驱动接回:直接渲染台账里已有的 rule.outcome。
  assert.doesNotMatch(view, /rule\s*\??\.\s*outcome/, 'rule.outcome 被接回渲染')
  // c. helper 改名逃逸:model 里任何名字带 Badge 的导出都算三档 helper 复活。
  assert.doesNotMatch(model, /(?:function|const|let|var)\s+\w*[Bb]adge/, 'model 里出现了 *Badge helper')
  assert.doesNotMatch(view, /\w*[Bb]adge\s*\(/, 'RoutesView 在调用某个 *Badge helper')
  // d. 页头必须是算出来的，不是常量。
  assert.match(view, /routesTierNote\(payload\.decisions\)/)
})

test('fallbackReason 全集有中文，认不出的不渲染（与 ruleReasonCopy 同口径）', () => {
  // 插件 selector-llm.js SELECTOR_ERROR_CODES + index.js 的 NOT_CONFIGURED / UNKNOWN。
  for (const code of ['NOT_CONFIGURED', 'UNKNOWN', 'NO_ADAPTER', 'TIMEOUT', 'ABORTED', 'STREAM_ERROR', 'OVERLOAD', 'BAD_OUTPUT', 'NO_TEXT', 'TOOL_CALL', 'UNPARSEABLE', 'PROVIDER_ERROR']) {
    const copy = fallbackReasonCopy(code)
    assert.ok(copy !== undefined, code + ' 没有中文文案')
    assert.doesNotMatch(copy, /\b(?!JSON\b)[A-Z_]{3,}\b/, code + ' 的文案里还带着机器码')
  }
  assert.equal(fallbackReasonCopy('brand-new'), undefined)
  assert.equal(fallbackReasonCopy(undefined), undefined)
})

test('posteriorCopy 与 decisionReasonCopy 由数据算出,不搬运原码', () => {
  assert.equal(posteriorCopy({ total: 1, filled: 0, pending: 1, cells: 1 }), '后验分母未采集')
  assert.equal(posteriorCopy({ total: 1, filled: 0, pending: 1, cells: 1, posterior: { observations: 0, cells: 0 } }), '后验暂无真实观测，三角色来自静态基准表')
  assert.match(posteriorCopy({ total: 1, filled: 1, pending: 0, cells: 1, posterior: { observations: 1, cells: 1 } }), /后验真实观测 1 条，落在 1 个已有胜负的/)
  assert.equal(decisionReasonCopy({ reason: 'static table', source: 'fallback' }), '静态表')
  assert.match(decisionReasonCopy({ reason: 'selector unavailable or timed out; static table', source: 'fallback' }) ?? '', /旧文案/)
  assert.equal(decisionReasonCopy({ reason: 'whatever', source: 'fallback' }), '静态表（回落理由未识别）')
  assert.equal(decisionReasonCopy({ reason: '该候选明确标注为 SQL coder', source: 'selector' }), '选择器原话 · 该候选明确标注为 SQL coder')
  assert.equal(decisionReasonCopy({ source: 'selector' }), undefined)
})

test('W17 路由页文案:覆盖句把影子行单列;影子行徽章按 pick/batchRef/adopted/outcome 算;shadowRowCopy 各分支', async () => {
  const { formatCoverage, routedTotal, shadowOutcomeCopy, shadowRowCopy } = await import('./routes-model.ts')
  const stats = { total: 9, window: 8, limit: 50, filled: 1, pending: 7, cells: 5, shadow: { total: 1, filled: 0, pending: 1, suggested: 1, agreed: 0 } }
  assert.equal(routedTotal(stats), 8)
  assert.equal(formatCoverage(stats), '显示最近 8 条，台账共 9 条（模型路由 8 条）· 已回填结果 1 条 · 覆盖 5 个 (角色, 模型) 格 · 另有 1 条影子建议行（1 条有建议、0 条已按 fleet 终态回填；不计入格与待回填）')
  assert.equal(formatCoverage({ total: 8, filled: 1, pending: 7, cells: 5 }), '显示最近 8 条，台账共 8 条（模型路由 8 条）· 已回填结果 1 条 · 覆盖 5 个 (角色, 模型) 格')
  const base = { id: 'dec-1', mode: 'shadow', pick: 'knowledge-m4', source: 'selector', outcome: null, shadow: { chosen: ['leo-01'], agreed: false } }
  assert.equal(shadowOutcomeCopy(base), '待派发关联')
  assert.equal(shadowOutcomeCopy({ ...base, batchRef: 'b-1', adopted: false }), '未被采用，不回填')
  assert.equal(shadowOutcomeCopy({ ...base, batchRef: 'b-1', adopted: true }), '待 fleet 终态回填')
  assert.equal(shadowOutcomeCopy({ ...base, batchRef: 'b-1', adopted: null }), '是否采用判不了')
  assert.equal(shadowOutcomeCopy({ ...base, pick: null as unknown as string }), '无建议，不回填')
  assert.equal(shadowOutcomeCopy({ ...base, outcome: 'ok' }), '建议机器上的 run 成功')
  assert.equal(shadowOutcomeCopy({ ...base, outcome: 'fail' }), '建议机器上的 run 失败/取消')
  assert.equal(shadowRowCopy(base), '用户勾选 leo-01 · 建议与勾选不一致 · 尚未派发或未关联批次')
  assert.equal(shadowRowCopy({ ...base, batchRef: 'b-f785f00d-8463-4369-9a02-4bf6dc7e3024', actualHosts: ['leo-01'], adopted: false }), '用户勾选 leo-01 · 建议与勾选不一致 · 批次 b-f785f00d… · 实际落在 leo-01 · 建议未被采用，批次成败不回填到本行（那是勾选机器的结果）')
  assert.equal(shadowRowCopy({ id: 'dec-2', source: 'selector' }), undefined)
})
