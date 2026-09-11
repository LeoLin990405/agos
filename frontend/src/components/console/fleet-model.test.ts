import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deriveFleetRows,
  executeFleetCostConfirmation,
  FLEET_FARM_HEADING,
  fleetBatchLamp,
  fleetFarmSource,
  fleetHostVisualState,
  fleetPluginAbsent,
  fleetRunLamp,
  fleetRunState,
  fleetUncollectedCopy,
  parseFleetHosts,
} from './fleet-model';

test('parseFleetHosts rejects missing or malformed hosts instead of inventing an empty fleet', () => {
  assert.throws(() => parseFleetHosts({}), /hosts 数组/);
  assert.throws(() => parseFleetHosts({ hosts: [{ ok: true }] }), /无效机器条目/);
  assert.deepEqual(parseFleetHosts({ hosts: [] }), { hosts: [] });
});

test('deriveFleetRows preserves real errors and distinguishes absent, unreadable, and zero wsFiles', () => {
  const rows = deriveFleetRows([
    { name: 'absent', ok: false, error: 'exit 255' },
    { name: 'unreadable', ok: true, wsFiles: null },
    { name: 'empty', ok: true, wsFiles: 0, inflight: 0, maxConcurrency: 6 },
  ]);

  assert.equal(rows[0].error, 'exit 255');
  assert.equal(rows[0].workspaceFiles, undefined);
  assert.equal(rows[1].workspaceFiles, '读不到');
  assert.equal(rows[2].workspaceFiles, '0');
  assert.equal(rows[2].concurrency, '0/6');
  assert.equal(rows[0].concurrency, undefined, '缺席并发字段不得伪造成 0');
});

test('deriveFleetRows selects the newest real run and derives only evidenced states', () => {
  const rows = deriveFleetRows([{
    name: 'worker',
    runs: [
      { runId: 'older', startedAt: 10, endedAt: 20, ok: true },
      { runId: 'newer', startedAt: 30, endedAt: null, ok: null },
    ],
  }]);

  assert.equal(rows[0].latestRun?.runId, 'newer');
  assert.equal(fleetRunState(rows[0].latestRun!), 'running');
  assert.equal(fleetRunState({ endedAt: 4, ok: true }), 'completed');
  assert.equal(fleetRunState({ endedAt: 4, ok: false }), 'failed');
  assert.equal(fleetRunState({}), 'unknown');
});

test('fleetHostVisualState exposes only SSH reachability or an active wake transition', () => {
  assert.equal(fleetHostVisualState(true), 'reachable');
  assert.equal(fleetHostVisualState(false), 'unreachable');
  assert.equal(fleetHostVisualState(false, { reachable: false, wakeState: 'waking', etaMs: 12_000 }), 'waking');
  assert.equal(
    fleetHostVisualState(false, { reachable: true, wakeState: 'awake', etaMs: 0 }),
    'unreachable',
    'power snapshot must not override the SSH probe',
  );
});

test('cost-bearing fleet actions cannot execute before a confirmation exists', async () => {
  const calls: string[] = [];
  const handlers = {
    wake: async (host: string) => { calls.push(`wake:${host}`); },
    preflight: async (host: string) => { calls.push(`preflight:${host}`); },
  };
  assert.equal(await executeFleetCostConfirmation(undefined, handlers), false);
  assert.deepEqual(calls, []);

  const requested = { kind: 'wake' as const, host: 'leo-03' };
  assert.deepEqual(calls, [], 'requesting confirmation must remain side-effect free');
  assert.equal(await executeFleetCostConfirmation(requested, handlers), true);
  assert.deepEqual(calls, ['wake:leo-03']);
});

test('cancelled runs and batches map to a non-running terminal lamp', () => {
  assert.equal(fleetRunLamp('cancelled'), 'failed');
  assert.equal(fleetBatchLamp('cancelled'), 'failed');
  assert.notEqual(fleetRunLamp('cancelled'), 'running');
  assert.notEqual(fleetBatchLamp('cancelled'), 'queued');
});

test('无 fleet 插件时标题不写 Homelab，来源写未采集', () => {
  assert.equal(FLEET_FARM_HEADING, '机器与机架');
  assert.doesNotMatch(FLEET_FARM_HEADING, /Homelab/);
  assert.equal(fleetPluginAbsent('HTTP 404 Not Found'), true);
  assert.equal(fleetPluginAbsent('not found'), true);
  assert.equal(fleetPluginAbsent('HTTP 500'), false);
  assert.equal(fleetFarmSource({
    hasHostData: false,
    hostCount: 0,
    reachableCount: 0,
    stalled: false,
    error: 'HTTP 404 not found',
  }), '未采集');
  assert.equal(fleetUncollectedCopy('HTTP 404 not found'), '未采集：HTTP 404');
  assert.equal(fleetFarmSource({
    hasHostData: true,
    hostCount: 3,
    reachableCount: 1,
    stalled: false,
  }), '已配置 3 · 可达 1');
});

test('FleetView 标题走采集函数，源码不得再写死 Homelab 执行农场', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, 'FleetView.tsx'), 'utf8');
  assert.match(src, /FLEET_FARM_HEADING/);
  assert.match(src, /fleetFarmSource\(/);
  assert.doesNotMatch(src, /Homelab 执行农场/);
});
