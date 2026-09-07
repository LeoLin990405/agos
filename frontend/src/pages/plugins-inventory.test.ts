import assert from 'node:assert/strict';
import test from 'node:test';
import { currentProcessCopy, INVENTORY_COPY, parsePluginsInventory, pluginDriftCopy } from './plugins-inventory.ts';

test('plugin inventory parse keeps absent drift as uncollected', () => {
  const parsed = parsePluginsInventory({
    at: 1,
    copy: INVENTORY_COPY,
    writable: false,
    currentProcess: 'web',
    agos: [{ id: 'dsh-agos', web: true, desktop: false }],
    profiles: [{
      name: 'web',
      path: '/tmp/web',
      present: true,
      pluginCount: 2,
      cordisIds: ['dsh-memory'],
      plugins: [
        { id: 'dsh-agos', kind: 'agos', present: true, drift: false },
        { id: 'dsh-civ', kind: 'host', present: true },
      ],
    }],
  });
  assert.equal(parsed.writable, false);
  assert.equal(parsed.agos[0]?.desktop, false);
  assert.equal(parsed.agos[0]?.drift, undefined);
  assert.equal(parsed.profiles[0]?.plugins[1]?.drift, undefined);
  assert.equal(parsed.profiles[0]?.plugins[0]?.drift, false);
  assert.throws(() => parsePluginsInventory(null));
  assert.equal(pluginDriftCopy(undefined), '漂移未采集');
  assert.equal(pluginDriftCopy(false), '与仓零漂移');
  assert.equal(pluginDriftCopy(true), '与仓有漂移');
  assert.equal(parsed.currentProcess, 'web');
  assert.equal(currentProcessCopy(undefined), '当前进程未采集');
  assert.equal(currentProcessCopy('web'), '当前进程 web');
});
