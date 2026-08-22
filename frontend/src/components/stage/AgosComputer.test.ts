import assert from 'node:assert/strict';
import test from 'node:test';
import type { FoldedConversation, ToolItem } from '@/fold/model';
import {
  selectFileEntries,
  selectSubagentBatches,
  selectTerminalEntries,
} from './agos-computer-model';

const tool = (patch: Partial<ToolItem> & Pick<ToolItem, 'callId' | 'name'>): ToolItem => ({
  kind: 'tool',
  argsRaw: '{}',
  turn: 1,
  step: 1,
  startAt: 100,
  endAt: 130,
  status: 'done',
  resultText: undefined,
  swarm: undefined,
  ...patch,
});

const snapshot = (items: ToolItem[]): FoldedConversation => ({
  header: undefined,
  title: undefined,
  items,
  turnsStarted: 0,
  turnsEnded: 0,
  lastTurnEndReason: undefined,
  todos: [],
  planMode: false,
  sandboxMode: undefined,
  approvalPolicy: undefined,
  queuedUserTexts: [],
  diagnostics: {
    events: 0,
    unknown: {},
    ignored: {},
    parseErrors: 0,
    danglingToolCalls: 0,
    orphanToolResults: 0,
    compactionPrunes: 0,
  },
});

test('selectTerminalEntries keeps true command, output state and duration', () => {
  const longOutput = 'x'.repeat(6_010);
  const rows = selectTerminalEntries(snapshot([
    tool({ callId: 'read', name: 'read_file', argsRaw: '{"path":"/tmp/a"}' }),
    tool({
      callId: 'shell', name: 'terminal.exec', argsRaw: '{"command":"npm test"}',
      resultText: longOutput, startAt: 200, endAt: 245, status: 'failed',
    }),
  ]));
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    callId: 'shell', command: 'npm test', output: 'x'.repeat(6_000), truncated: true,
    status: 'failed', startAt: 200, durationMs: 45,
  });
});

test('selectFileEntries groups true paths, tools and newest activity', () => {
  const rows = selectFileEntries(snapshot([
    tool({ callId: 'r1', name: 'read_file', argsRaw: '{"file_path":"/repo/a.ts"}', startAt: 100 }),
    tool({ callId: 'w1', name: 'write_file', argsRaw: '{"path":"/repo/b.ts"}', startAt: 150 }),
    tool({ callId: 'e1', name: 'edit_file', argsRaw: '{"filePath":"/repo/a.ts"}', startAt: 200 }),
    tool({ callId: 'bad', name: 'write_file', argsRaw: 'not-json', startAt: 300 }),
  ]));
  assert.deepEqual(rows, [
    { path: '/repo/a.ts', tail: 'a.ts', count: 2, lastAt: 200, tools: ['read_file', 'edit_file'] },
    { path: '/repo/b.ts', tail: 'b.ts', count: 1, lastAt: 150, tools: ['write_file'] },
  ]);
});

test('selectSubagentBatches refreshes only call ids owned by the conversation', () => {
  const rows = selectSubagentBatches(snapshot([
    tool({
      callId: 'owned', name: 'swarm_batch', status: 'running',
      swarm: [
        { index: 0, item: 'a', type: undefined, model: undefined, status: 'completed' },
        { index: 1, item: 'b', type: undefined, model: undefined, status: 'running' },
      ],
    }),
  ]), {
    done: 2,
    total: 5,
    batches: [
      { callId: 'owned', label: 'live', done: 2, failed: 1, total: 4 },
      { callId: 'foreign', label: 'other session', done: 0, failed: 0, total: 1 },
    ],
  });
  assert.deepEqual(rows, [{
    callId: 'owned', label: 'swarm_batch', done: 2, failed: 1, total: 4, running: true,
  }]);
});

test('remote subagent selection does not merge a colliding local live batch', () => {
  const remote = snapshot([
    tool({
      callId: 'same-call-id', name: 'swarm_batch', status: 'done',
      swarm: [
        { index: 0, item: 'remote item', type: undefined, model: undefined, status: 'completed' },
      ],
    }),
  ]);

  // AgosComputer passes undefined for live progress in remote mode. Even if a
  // local batch happens to reuse the same call id, the remote fold stays the
  // sole source of truth.
  assert.deepEqual(selectSubagentBatches(remote, undefined), [{
    callId: 'same-call-id',
    label: 'swarm_batch',
    done: 1,
    failed: 0,
    total: 1,
    running: false,
  }]);
});

test('selectSubagentBatches keeps settled progress owned by this session', () => {
  const sessionId = 'session-534efffb-73bd-44ea-ae17-af69aa96986b';
  const rows = selectSubagentBatches(snapshot([
    tool({ callId: 'tool-sub', name: 'subagent', status: 'done' }),
  ]), undefined, {
    sessionId,
    progressCalls: [
      {
        callId: `host:${sessionId}`,
        parentSessionId: sessionId,
        description: 'host delegation',
        rows: [
          { status: 'failed' },
          { status: 'completed' },
        ],
      },
      {
        callId: 'host:session-other',
        parentSessionId: 'session-other',
        rows: [{ status: 'running' }],
      },
    ],
  });
  assert.deepEqual(rows, [{
    callId: `host:${sessionId}`,
    label: 'host delegation',
    done: 1,
    failed: 1,
    total: 2,
    running: false,
  }]);
});

test('selectSubagentBatches falls back to swarm-class tools when progress is empty', () => {
  const rows = selectSubagentBatches(snapshot([
    tool({ callId: 'd1', name: 'delegate_task', status: 'done' }),
    tool({ callId: 'b1', name: 'bash', status: 'done' }),
  ]), undefined);
  assert.deepEqual(rows, [{
    callId: 'd1', label: 'delegate_task', done: 1, failed: 0, total: 1, running: false,
  }]);
});
