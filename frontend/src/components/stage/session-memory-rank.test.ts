import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INJECT_IS_NOT_VERDICT_COPY,
  STORE_UNREAD_COPY,
  canRecordRelevance,
  memoryLexicalScore,
  hitByItemId,
  parseMemoryRelevance,
  relevanceLedgerCopy,
} from './session-memory-rank';

test('missing session stays uncollected and zero rows stay zero', () => {
  const missing = parseMemoryRelevance({
    sessionId: '',
    collected: false,
    evidenceRows: null,
    copy: 'sessionId 未采集',
    queryCollected: false,
    hits: [],
    callNote: INJECT_IS_NOT_VERDICT_COPY,
  });
  assert.equal(missing.evidenceRows, null);
  assert.equal(relevanceLedgerCopy(missing), 'sessionId 未采集');
  assert.equal(relevanceLedgerCopy(parseMemoryRelevance({
    sessionId: 's1',
    collected: false,
    evidenceRows: null,
    copy: STORE_UNREAD_COPY,
    queryCollected: false,
    hits: [],
    callNote: INJECT_IS_NOT_VERDICT_COPY,
  })), STORE_UNREAD_COPY);
  assert.equal(memoryLexicalScore('不要改 fold', '不要这样'), 0);
  assert.ok(memoryLexicalScore('fold', 'project_csdiy_math_material_folding') > 0);
  const zero = parseMemoryRelevance({
    sessionId: 's1',
    collected: true,
    evidenceRows: 0,
    copy: '相关账本 0 行',
    queryCollected: true,
    method: 'lexical+posterior',
    note: '词面短名单，不是模型推荐',
    hits: [{
      id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      lexical: 0.5,
      posterior: 0.6,
      benchRank: 1,
      evidence: { s: 0, f: 0 },
      method: 'lexical+posterior',
    }],
    callNote: INJECT_IS_NOT_VERDICT_COPY,
  });
  assert.equal(relevanceLedgerCopy(zero), '相关账本 0 行');
  assert.equal(hitByItemId(zero.hits, 'aaaaaaaaaaaaaaaaaaaaaaaa')?.lexical, 0.5);
  assert.equal(hitByItemId(zero.hits, 'missing'), undefined);
  assert.equal(canRecordRelevance(zero.hits[0]), true);
  assert.equal(canRecordRelevance(undefined), false);
  assert.equal(canRecordRelevance({ id: 'not-an-item-id' }), false);
  assert.throws(() => parseMemoryRelevance(null));
});
