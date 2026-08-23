import assert from 'node:assert/strict'
import test from 'node:test'
import { candidatesForRoute, normalizeVerdict, semanticLabel } from '../lib/labels.js'

test('semantic labels cluster verdicts instead of hashing prose', () => {
  assert.equal(normalizeVerdict('放行'), 'allow')
  assert.equal(normalizeVerdict('deny: 越权'), 'deny')
  assert.equal(semanticLabel({ reason: 'unsure about the patch' }), 'unsure')
  assert.equal(semanticLabel({ label: 'Code Review' }), 'code-review')
  // 2026-08-22 验收改判:原断言是 undefined,那把一个缺陷写成了预期 ——
  // labels.js 里 kebab 化特意保留了 \u4e00-\u9fff,而放行闸却是纯 ASCII,
  // 于是**任何**未精确命中别名表的中文一律 undefined → 恒 ESCALATE,
  // 而「自造语义 label 解决恒 ESCALATE」正是这个模块存在的理由。现在中文可聚类。
  assert.equal(semanticLabel({ reason: '一段人人不同的自然语言评审' }), '一段人人不同的自然语言评审')
  const rows = candidatesForRoute([
    { id: 'a', reason: 'allow this change' },
    { id: 'b', reason: '放行' },
  ])
  assert.equal(rows[0].label, 'allow')
  assert.equal(rows[1].label, 'allow')
  assert.equal(semanticLabel({ pick: 'qwen3.8-max' }), undefined, '模型 id 不是任务类')
})

test('中文全角标点与否定式(2026-08-22 验收补)', () => {
  // 原实现只按 ASCII 标点切词,中文正常书写用全角 → 6 条中文别名形同虚设
  assert.equal(normalizeVerdict('放行，因为无风险'), 'allow')
  assert.equal(normalizeVerdict('拒绝：越权'), 'deny')
  assert.equal(normalizeVerdict('通过。'), 'allow')
  // 否定式:原实现在「do not approve」里命中 approve,把反对读成同意
  assert.equal(normalizeVerdict('do not approve this'), 'deny')
  assert.equal(normalizeVerdict('never approve'), 'deny')
  assert.equal(normalizeVerdict('I would approve this'), 'allow')
  assert.equal(normalizeVerdict('不同意'), 'deny')
  assert.equal(normalizeVerdict('不予批准'), 'deny')
})

test('超长标签用有界哈希,不得凭前缀伪造共识(2026-08-22 验收补)', () => {
  // 原实现 .slice(0,32):前 32 字符相同的**相反结论**会拿到同一个 label,
  // 被 route() 判成同簇 → 凭空造出一个不存在的共识(撞「数据零编造」)。
  const A = 'I read the diff carefully and it is fine'
  const B = 'I read the diff carefully and it is broken'
  const la = semanticLabel({ reason: A })
  const lb = semanticLabel({ reason: B })
  assert.notEqual(la, lb, '相反结论不得共用 label')
  assert.ok(la.length <= 32, '标签长度必须有界')
  // 但**相同**的长文本必须仍然同簇 —— 否则该聚的也聚不上
  assert.equal(semanticLabel({ reason: A }), la)
})
