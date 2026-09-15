import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MEMORY_UNCOLLECTED_COPY,
  parseTurnEvidence,
  turnEvidenceChips,
  turnEvidenceFeedbackTargets,
  turnEvidenceId,
  turnEvidenceImpressionLabels,
  turnEvidenceMatches,
  turnEvidenceUnrecordableCopy,
} from './turn-evidence';

test('turn evidence parse keeps absence as uncollected', () => {
  const parsed = parseTurnEvidence({
    sessionId: 's1',
    collected: false,
    copy: '本跳未采集',
    memory: { collected: false, copy: MEMORY_UNCOLLECTED_COPY },
    skills: { collected: false, copy: '本跳技能目录未采集' },
    plugins: { collected: true, profile: 'web', copy: '当前进程 web', agosLoaded: ['dsh-agos'] },
  });
  assert.equal(parsed.memory.prepended, null);
  assert.equal(parsed.plugins.profile, 'web');
  assert.deepEqual(turnEvidenceChips(parsed), [
    MEMORY_UNCOLLECTED_COPY,
    '本跳技能目录未采集',
    '当前进程 web',
  ]);
  assert.deepEqual(turnEvidenceImpressionLabels(parsed), []);
  const withImpressions = parseTurnEvidence({
    sessionId: 's1',
    collected: true,
    copy: '本跳已记录 pre-step 投影',
    memory: {
      collected: true,
      copy: '本跳回注 1/2 · 词面短名单 · 含约束保送',
      reserved: true,
      query: '3091',
      impressions: [{ id: 'aaaaaaaaaaaaaaaaaaaaaaaa', kind: 'constraint', text: '不要改 fold', method: 'constraint-reserve' }],
    },
    skills: { collected: false, copy: '本跳技能目录未采集' },
    plugins: { collected: true, profile: 'web', copy: '当前进程 web' },
  });
  assert.equal(withImpressions.memory.reserved, true);
  assert.deepEqual(turnEvidenceImpressionLabels(withImpressions), ['不要改 fold（约束保送，不是更相关）']);
  assert.deepEqual(turnEvidenceFeedbackTargets(withImpressions).map((row) => row.id), ['aaaaaaaaaaaaaaaaaaaaaaaa']);
  assert.equal(turnEvidenceUnrecordableCopy(withImpressions), undefined);
  const missingId = parseTurnEvidence({
    sessionId: 's1',
    collected: true,
    copy: '本跳已记录 pre-step 投影',
    memory: {
      collected: true,
      copy: '本跳回注 1 条',
      impressions: [{ id: '', kind: 'fact', text: 'web 口在 3091' }],
    },
    skills: { collected: false, copy: '本跳技能目录未采集' },
    plugins: { collected: true, profile: 'web', copy: '当前进程 web' },
  });
  assert.deepEqual(turnEvidenceFeedbackTargets(missingId), []);
  assert.equal(turnEvidenceUnrecordableCopy(missingId), '曝光条目没有 id，不能记相关');
  assert.deepEqual(turnEvidenceFeedbackTargets(parsed), []);
  assert.equal(turnEvidenceUnrecordableCopy(parsed), undefined);
  assert.throws(() => parseTurnEvidence(null));
});

test('turn evidence retains host binding and persistence facts without inventing identifiers', () => {
  const evidence = parseTurnEvidence({
    sessionId: 'session-a', turn: 4, step: 0,
    observed: true, collected: false, persisted: false, durable: false, persistError: 'EACCES',
  });
  assert.equal(evidence.turn, '4');
  assert.equal(evidence.step, '0');
  assert.equal(evidence.observed, true);
  assert.equal(evidence.collected, false);
  assert.equal(evidence.persisted, false);
  assert.equal(evidence.durable, false);
  assert.equal(evidence.persistError, 'EACCES');
  assert.equal(turnEvidenceMatches(evidence, 'session-a', { turn: '4', step: 0 }), true);
  assert.equal(turnEvidenceMatches(evidence, 'session-b', { turn: 4, step: 0 }), false);
  assert.equal(turnEvidenceMatches(evidence, 'session-a', { turn: 5, step: 0 }), false);
  assert.equal(turnEvidenceMatches(evidence, 'session-a', { turn: 4, step: 1 }), false);
  const unbound = parseTurnEvidence({ sessionId: 'session-a', collected: true });
  assert.equal(unbound.turn, null);
  assert.equal(unbound.step, null);
  assert.equal(unbound.observed, false);
  assert.equal(unbound.persisted, null);
  assert.equal(unbound.durable, null);
  assert.equal(turnEvidenceMatches(unbound, 'session-a', { turn: 0, step: 0 }), false);
  for (const invalid of [undefined, null, '', '  ', Number.NaN, Infinity, 0.5, {}]) {
    assert.equal(turnEvidenceId(invalid), null);
  }
  assert.equal(turnEvidenceId('host-turn-id'), 'host-turn-id');
});
