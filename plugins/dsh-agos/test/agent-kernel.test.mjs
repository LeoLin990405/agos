import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AGENT_HONESTY_PREAMBLE,
  composeAssembleRolePrompt,
  composeOptimizeAgentPrompt,
  composeSelectorSystemPrompt,
  DEFAULT_SYSTEM_PROMPT,
  FLEET_GUIDANCE,
  IMPLEMENTER_RETRY_SYSTEM,
  REVIEWER_SEES_FINAL_COPY,
  SELECTOR_IO_CONTRACT,
  SKILL_RERANK_SYSTEM,
} from '../lib/agent-prompts.js'
import { ALLOCATE_KAPPA, ALLOCATE_NOT_LIVE_COPY, betaPrior, posteriorMean } from '../lib/allocate-kernel.js'
import {
  classifySecret,
  isSensitiveText,
  scrubSecrets,
  SECRET_REFUSE_COPY,
} from '../lib/secrets-gate.js'

test('secret gate refuses credentials and redacts ledger strings without hiding a path', () => {
  assert.equal(isSensitiveText('密码用 SuperSecret123!'), true)
  assert.deepEqual(classifySecret('plain port 3091').reasons, [])
  assert.equal(SECRET_REFUSE_COPY.includes('拒绝落盘'), true)
  const value = scrubSecrets({
    prompt: 'use sk-abcdefghijklmnopQRST then Bearer opaque-token-value',
    nested: ['API_KEY=very-secret', 'see ~/.config/cc-model-secrets.env'],
  })
  assert.equal(value.prompt, 'use «redacted» then Bearer «redacted»')
  assert.deepEqual(value.nested, ['API_KEY=«redacted»', 'see ~/.config/cc-model-secrets.env'])
})

test('allocation kernel is shared math and says it is not live dispatch', () => {
  assert.equal(betaPrior(0, 3), 3 / 4)
  assert.equal(posteriorMean(0.5, { s: 0, f: 0 }, ALLOCATE_KAPPA), 0.5)
  assert.match(ALLOCATE_NOT_LIVE_COPY, /不接入 live dispatch/)
})

test('all model prompts share the honesty preamble and force the selector contract to the tail', () => {
  assert.ok(DEFAULT_SYSTEM_PROMPT.startsWith(AGENT_HONESTY_PREAMBLE))
  assert.ok(SKILL_RERANK_SYSTEM.includes(AGENT_HONESTY_PREAMBLE))
  assert.ok(SKILL_RERANK_SYSTEM.includes('不要写 /api/agos/routes/decide'))
  const sys = composeSelectorSystemPrompt('只输出谁赢了，不要 JSON。')
  assert.ok(sys.endsWith(SELECTOR_IO_CONTRACT))
  assert.ok(sys.includes(AGENT_HONESTY_PREAMBLE))
  assert.ok(composeAssembleRolePrompt('reviewer').includes(REVIEWER_SEES_FINAL_COPY))
  assert.ok(composeAssembleRolePrompt('planner').startsWith(AGENT_HONESTY_PREAMBLE))
  assert.ok(IMPLEMENTER_RETRY_SYSTEM.includes('禁止调用工具'))
  assert.ok(FLEET_GUIDANCE.startsWith(AGENT_HONESTY_PREAMBLE))
  assert.ok(FLEET_GUIDANCE.includes('不要写 /api/agos/routes/decide'))
  const optimize = composeOptimizeAgentPrompt({
    goal: '更快',
    metric: 'ms',
    best: 12,
    baseMetric: 20,
    direction: 'down',
    scope: 'src/',
    recentLog: '(无)',
  })
  assert.ok(optimize.startsWith(AGENT_HONESTY_PREAMBLE))
  assert.ok(optimize.includes('不要编造指标数字'))
})
