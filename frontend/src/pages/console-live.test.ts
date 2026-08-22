import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deriveConsole,
  formatCollectedAt,
  normalizeProgressPayload,
  numAt,
  overviewLamp,
} from './console-live.tsx';
import { idleResource, mergeResource } from '@/lib/resource';
import type { SessionSummaryRow, TelemetryState } from '@/stores/live';

const row: SessionSummaryRow = {
  sessionId: 'session-real',
  title: '真实会话',
  cwd: '/workspace',
  updatedAt: 1,
  running: false,
  blank: false,
  turns: 2,
  tokens: 10,
  agentPreset: '',
};

test('numAt preserves missing metrics instead of inventing zero', () => {
  assert.equal(numAt({}, 'sessions', 'total'), undefined);
  assert.equal(numAt({ sessions: {} }, 'sessions', 'total'), undefined);
  assert.equal(numAt({ skills: undefined }, 'skills', 'skills'), undefined);
  assert.equal(numAt({ sessions: { total: 0 } }, 'sessions', 'total'), 0);
  assert.equal(numAt({ sessions: { total: Number.NaN } }, 'sessions', 'total'), undefined);
});

test('deriveConsole keeps every absent overview group uncollected', () => {
  const telemetry: TelemetryState = { overview: {}, progress: undefined, at: 0 };
  const derived = deriveConsole(telemetry, { rows: [row] });

  assert.equal(derived.live, true);
  assert.equal(derived.running, undefined);
  assert.equal(derived.failed, undefined);
  assert.equal(derived.rows, undefined);
  assert.equal(derived.calls, undefined);
  assert.equal(derived.sessionsTotal, undefined);
  assert.equal(derived.plansTotal, undefined);
  assert.equal(derived.plansExecuted, undefined);
  assert.equal(derived.skills, undefined);
  assert.equal(derived.skillsWarn, undefined);
  assert.equal(derived.skillsError, undefined);
  assert.equal(derived.progressLive, false);
  assert.equal(derived.sessionsLive, false);
  assert.deepEqual(derived.matrix, [row]);
});

test('deriveConsole retains genuine zero values and real progress counts', () => {
  const telemetry: TelemetryState = {
    overview: {
      lineage: { running: 0, failed: 0, rows: 0 },
      sessions: { total: 0 },
      plans: { total: 0, executed: 0 },
      skills: { skills: 0, warn: 0, error: 0 },
    },
    progress: { calls: [] },
    at: 1,
  };
  const derived = deriveConsole(telemetry, { rows: [] });

  assert.equal(derived.running, 0);
  assert.equal(derived.failed, 0);
  assert.equal(derived.calls, 0);
  assert.equal(derived.rows, 0);
  assert.equal(derived.sessionsTotal, 0);
  assert.equal(derived.plansTotal, 0);
  assert.equal(derived.plansExecuted, 0);
  assert.equal(derived.skills, 0);
  assert.equal(derived.skillsWarn, 0);
  assert.equal(derived.skillsError, 0);
  assert.equal(derived.skillsServedWarn, undefined);
  assert.equal(derived.progressLive, true);
  assert.equal(derived.sessionsLive, false);
});

test('deriveConsole surfaces servedToModel skill health separately from console-only', () => {
  const derived = deriveConsole({
    overview: {
      skills: {
        skills: 400,
        warn: 95,
        error: 0,
        servedToModel: { skills: 384, warn: 91, error: 0 },
        consoleOnly: { skills: 363, warn: 4, error: 0 },
        consistency: { summary: '59 个 skill 在多根重复，其中 59 个内容不一致' },
      },
    },
    progress: undefined,
    at: 1,
  }, { rows: [] });
  assert.equal(derived.skillsServedWarn, 91);
  assert.equal(derived.skillsConsoleWarn, 4);
  assert.match(derived.skillsConsistency ?? '', /59 个/);
});
test('deriveConsole prefers the overview lineage call count when progress is absent', () => {
  const derived = deriveConsole({
    overview: { lineage: { calls: 7 } },
    progress: undefined,
    at: 1,
  }, { rows: [] });

  assert.equal(derived.calls, 7);
});

test('deriveConsole marks the session list ready only after a completed load', () => {
  const pending = deriveConsole({ overview: {}, progress: undefined, at: 0 }, { rows: [row], loadedAt: 0 });
  const ready = deriveConsole({ overview: {}, progress: undefined, at: 0 }, { rows: [row], loadedAt: 10 });

  assert.equal(pending.sessionsLive, false);
  assert.equal(ready.sessionsLive, true);
});

test('normalizeProgressPayload accepts host map/array shapes without inventing rows', () => {
  assert.deepEqual(normalizeProgressPayload({ calls: { a: { rows: [] }, ignored: null } }), {
    calls: [{ callId: 'a', rows: [] }],
  });
  assert.deepEqual(normalizeProgressPayload({ calls: [{ callId: 'b' }, null, 3] }), {
    calls: [{ callId: 'b' }],
  });
  assert.equal(normalizeProgressPayload({ calls: 'invalid' }), undefined);
  assert.equal(normalizeProgressPayload(undefined), undefined);
});

test('a failed overview refresh keeps old data but cannot retain a running lamp', () => {
  const ready = mergeResource(idleResource<Record<string, unknown>>(), {
    type: 'resolve',
    data: { at: 100, sessions: { total: 4 } },
    at: 100,
  });
  const degraded = mergeResource(mergeResource(ready, { type: 'load' }), {
    type: 'reject',
    error: Object.assign(new Error('gateway'), { status: 502 }),
    at: 200,
  });

  assert.deepEqual(degraded.data, { at: 100, sessions: { total: 4 } });
  assert.equal(degraded.at, 100);
  assert.equal(degraded.error?.status, 502);
  assert.equal(overviewLamp(degraded.status), 'failed');
  assert.equal(deriveConsole({ overview: degraded.data, progress: undefined, at: degraded.at ?? 0 }, { rows: [] }).sessionsTotal, 4);
});

test('overview lamp and collected time distinguish ready, pending, and unavailable', () => {
  assert.equal(overviewLamp('ready'), 'done');
  assert.equal(overviewLamp('loading'), 'queued');
  assert.equal(overviewLamp('idle'), 'queued');
  assert.equal(overviewLamp('degraded'), 'failed');
  assert.equal(overviewLamp('error'), 'failed');
  assert.equal(formatCollectedAt(undefined), '时间未采集');
  assert.equal(formatCollectedAt(Number.NaN), '时间未采集');
  assert.notEqual(formatCollectedAt(1_755_700_000_000), '时间未采集');
});
