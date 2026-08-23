import assert from 'node:assert/strict'
import test from 'node:test'
import { CLOSED_ROLES, normalizeRole } from '../lib/roles.js'
import { sanitizePreview } from '../lib/sanitize.js'
import { selectorCacheKey } from '../lib/index.js'
import { normalizeConfig } from '../lib/config.js'

test('role aliases collapse onto the closed FuguNano set', () => {
  assert.deepEqual(CLOSED_ROLES, ['planner', 'implementer', 'reviewer', 'fixer'])
  assert.equal(normalizeRole('coder'), 'implementer')
  assert.equal(normalizeRole('sql'), 'implementer')
  assert.equal(normalizeRole('planning'), 'planner')
  assert.equal(normalizeRole('code-review'), 'reviewer')
  assert.equal(normalizeRole('invented-role'), undefined)
})

test('selector cache key changes when settings-derived fields change', () => {
  const a = selectorCacheKey(normalizeConfig({ model: 'step-3.7-flash', systemPrompt: '' }))
  const b = selectorCacheKey(normalizeConfig({ model: 'step-router-v1', systemPrompt: 'prefer flash' }))
  assert.notEqual(a, b)
})

test('sanitizePreview drops credentials and truncates', () => {
  assert.equal(sanitizePreview('password is SuperSecret123 for NAS'), undefined)
  const long = 'x'.repeat(200)
  assert.equal([...sanitizePreview(long, 80)].length, 80)
  assert.equal(sanitizePreview('写一条按月汇总 GMV 的 SQL'), '写一条按月汇总 GMV 的 SQL')
})
