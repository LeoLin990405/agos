import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseTraceSessions,
  TRACE_EMPTY_COPY,
  TRACE_LOADING_COPY,
  traceFailureText,
  traceUncollectedCopy,
} from './trace-model.ts';

test('parseTraceSessions 认数组或 {sessions}，丢掉没有 id 的行', () => {
  const rows = parseTraceSessions({
    sessions: [
      {
        rawId: 'session-aa',
        id: 'aa',
        title: '验收',
        createdAt: 1,
        cwd: '/tmp',
        model: 'fake',
        stats: { turns: 2, steps: 3, llmMs: 10, toolMs: 20 },
      },
      { id: '' },
    ],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.rawId, 'session-aa');
  assert.equal(rows[0]?.turns, 2);
  assert.equal(rows[0]?.toolMs, 20);
  assert.deepEqual(parseTraceSessions([]), []);
});

test('parseTraceSessions 缺 sessions 数组就抛，不装成健康空列表', () => {
  assert.throws(() => parseTraceSessions({}), /sessions 数组/);
  assert.throws(() => parseTraceSessions(null), /不是对象或数组/);
  assert.throws(() => parseTraceSessions('nope'), /不是对象或数组/);
});

test('404 / 空消息都写成未采集，不假装暂无轨迹', () => {
  assert.equal(traceFailureText(404, 'not found'), 'HTTP 404 · not found');
  assert.equal(traceFailureText(undefined, ''), '未采集');
  assert.match(traceUncollectedCopy(404, 'not found'), /未采集：HTTP 404/);
  assert.notEqual(traceUncollectedCopy(404, 'not found'), TRACE_EMPTY_COPY);
  assert.notEqual(TRACE_LOADING_COPY, TRACE_EMPTY_COPY);
});

test('TraceView 对 HTTP 失败必须出未采集+重试，不能只剩图例', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, 'TraceView.tsx'), 'utf8');
  assert.match(src, /traceUncollectedCopy/);
  assert.match(src, /resource\.refresh\(\)/);
  assert.match(src, /role="alert"/);
  assert.match(src, /TRACE_EMPTY_COPY/);
  assert.doesNotMatch(
    src,
    /catch \{ \/\* 后端缺席时保持空态 \*\/ \}/,
    '404 再被吞成空态就会只剩图例',
  );
});
