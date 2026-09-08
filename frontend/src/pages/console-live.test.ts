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

// ---------------------------------------------------------------- W16 收件箱多台账汇合
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { COUNCIL_SERVER_WINDOW, inboxFromCouncil, inboxFromRoutes, inboxFromSkillsDrift, sortInbox } from './console-live.tsx';
import { AttentionInbox, inboxBadgeState, inboxEmptyText, inboxSubtitle } from '@/components/console/AttentionInbox';
import type { RoutesPayload } from '@/components/console/routes-model';
import type { CouncilRecord } from '@/components/console/council-ledger-model';

// 三源 fixture 照 2026-08-23 18:xx 实测形状(GET /api/agos/routes stats、/api/cn/council-records 记录、overview.skills 组)写字面量
const routesLive: RoutesPayload = {
  at: 1787480000000,
  decisions: [{ ts: 1787329561900, taskType: 'sql', role: 'coder', pick: 'qwen3.8-max', candidates: [], outcome: null } as unknown as RoutesPayload['decisions'][number], { ts: 1787409999000, role: 'coder', pick: 'x', candidates: [], outcome: null } as unknown as RoutesPayload['decisions'][number]],
  // 2026-08-23 22:04 后台账多了 1 条影子行:total 9、pending 仍 7(影子行不计)、shadow 小计 1
  stats: { total: 9, window: 8, limit: 50, filled: 1, pending: 7, cells: 5, shadow: { total: 1, filled: 0, pending: 1, suggested: 1, agreed: 0 }, posterior: { observations: 1, cells: 1 } },
};
const councilFlagged: CouncilRecord = {
  kind: undefined, time: '2026-08-18T06:52:21.966Z', question: 'Python 的 GIL 在 3.13 里发生了什么变化?', arbiter: 'stepfun',
  parsedOk: true, consensus: false, inconclusive: undefined, verdict: undefined, disagreements: undefined,
  flagged: ['minimax-cn', 'stepfun'], imagePath: undefined, panelists: [],
};
const councilClean: CouncilRecord = { ...councilFlagged, question: '干净记录', flagged: [] };
const skillsOverview = {
  skills: { skills: 746, warn: 172, error: 0, at: 1787479651013, consistency: { duplicateNames: 359, drifted: 59, summary: '359 个 skill 在多根重复，其中 59 个内容不一致' } },
};

test('W16 inboxFromRoutes: pending>0 才产出一条 warning,口径是 stats.pending 不是窗口长度;未采集不产出', () => {
  const [item] = inboxFromRoutes(routesLive);
  assert.ok(item);
  assert.equal(item.type, 'warning');
  assert.equal(item.source, 'routes');
  assert.match(item.title, /^7 条路由决策待回填结果$/);
  assert.match(item.description, /不是等人批准/);
  assert.equal(item.description, '模型路由 8 条,已回填 1 条;另有 1 条影子建议行不计入。待回填是 outcome 仍为空,不是等人批准。', '同屏数字要自洽:8−1=7 条待回填');
  const noShadow = inboxFromRoutes({ ...routesLive, stats: { ...routesLive.stats, total: 8, shadow: undefined } })[0];
  assert.equal(noShadow?.description, '模型路由 8 条,已回填 1 条。待回填是 outcome 仍为空,不是等人批准。');
  assert.equal(item.timestamp, `最近决策 ${new Date(1787409999000).toLocaleString('zh-CN', { hour12: false })}`, '时间槽是台账里最近一条决策,不是 GET 响应时间');
  assert.equal(inboxFromRoutes({ ...routesLive, decisions: [] })[0]?.timestamp, '决策时间未采集');
  assert.deepEqual(inboxFromRoutes({ ...routesLive, stats: { ...routesLive.stats, pending: 0 } }), []);
  assert.deepEqual(inboxFromRoutes(undefined), []);
});

test('W16 inboxFromSkillsDrift: drifted>0 产出一条;skills 组缺席或 drifted 为 0 不产出', () => {
  const [item] = inboxFromSkillsDrift(skillsOverview);
  assert.ok(item);
  assert.equal(item.source, 'skills');
  assert.equal(item.title, '59 个 skill 多根内容不一致');
  assert.equal(item.description, '359 个 skill 在多根重复，其中 59 个内容不一致');
  assert.deepEqual(inboxFromSkillsDrift(undefined), []);
  assert.deepEqual(inboxFromSkillsDrift({ skills: { skills: 1, consistency: { drifted: 0 } } }), []);
  assert.deepEqual(inboxFromSkillsDrift({ skills: { skills: 1 } }), [], 'consistency 缺席 = 未采集,不是 0');
});

test('W16 inboxFromCouncil: flagged 非空每条一项;kind 缺席写「类型未采集」;time 转绝对时间;干净记录不产出', () => {
  const items = inboxFromCouncil([councilClean, councilFlagged, { ...councilFlagged, time: undefined }]);
  assert.equal(items.length, 2);
  assert.match(items[0]!.title, /^评审被标记:Python 的 GIL/);
  assert.match(items[0]!.description, /^类型未采集 · 疑似编造的评委:minimax-cn、stepfun$/);
  assert.equal(items[0]!.timestamp, new Date(Date.parse('2026-08-18T06:52:21.966Z')).toLocaleString('zh-CN', { hour12: false }));
  assert.equal(items[1]!.timestamp, '时间未采集');
  assert.notEqual(items[0]!.id, items[1]!.id);
  assert.deepEqual(inboxFromCouncil(undefined), []);
  assert.deepEqual(inboxFromCouncil([]), []);
});

test('W16 deriveConsole 真排序 + 来源状态:失败 > 警告 > 在跑,同档谱系 > 评审 > 路由 > 技能;缺席源不产出且标 absent', () => {
  const telemetry: TelemetryState = {
    overview: skillsOverview,
    progress: { calls: [
      { callId: 'c1', description: '批次一', rows: [{ index: 0, status: 'running' }, { index: 1, status: 'completed' }] },
      { callId: 'c2', description: '批次二', rows: [{ index: 0, status: 'failed', item: 'x', error: 'boom' }] },
    ] },
    at: 1,
  };
  const full = deriveConsole(telemetry, { rows: [] }, { routes: routesLive, council: [councilFlagged] });
  assert.deepEqual(full.inbox.map((it) => `${it.type}:${it.source}`), ['error:progress', 'warning:council', 'warning:routes', 'warning:skills', 'running:progress']);
  assert.deepEqual(full.inboxSources, { progress: 'ready', routes: 'ready', skills: 'ready', council: 'ready' });

  const partial = deriveConsole({ overview: {}, progress: undefined, at: 0 }, { rows: [] }, { routes: routesLive });
  assert.deepEqual(partial.inbox.map((it) => it.source), ['routes']);
  assert.deepEqual(partial.inboxSources, { progress: 'absent', routes: 'ready', skills: 'absent', council: 'absent' });
  assert.deepEqual(partial.inboxNotes, []);
  const stale = deriveConsole({ overview: {}, progress: undefined, at: 0 }, { rows: [] }, { routes: routesLive, routesStale: true, council: Array.from({ length: COUNCIL_SERVER_WINDOW }, () => councilClean), councilStale: true });
  assert.equal(stale.inboxSources.routes, 'stale');
  assert.equal(stale.inboxSources.council, 'stale');
  assert.deepEqual(stale.inboxNotes, [`评审台账只回最近 ${COUNCIL_SERVER_WINDOW} 条,更早的被标记记录看不到`]);

  const refreshStale = deriveConsole({
    overview: { skills: { skills: 4, warn: 0, error: 0 } },
    progress: { calls: [] },
    at: 1,
  }, { rows: [] }, { progressStale: true, skillsStale: true });
  assert.equal(refreshStale.inboxSources.progress, 'stale');
  assert.equal(refreshStale.inboxSources.skills, 'stale');
  assert.equal(refreshStale.skills, 4);
  assert.equal(refreshStale.progressLive, true);
  assert.equal(inboxEmptyText(refreshStale.inboxSources), '已采集的来源里无待处理;未采集:路由台账、评审台账;沿用旧数据:谱系进度、技能审计');
  const allPresentStale = deriveConsole({
    overview: { skills: { skills: 4, warn: 0, error: 0 } },
    progress: { calls: [] },
    at: 1,
  }, { rows: [] }, {
    routes: { ...routesLive, stats: { ...routesLive.stats, pending: 0 } },
    council: [],
    progressStale: true,
    skillsStale: true,
  });
  assert.deepEqual(allPresentStale.inboxSources, { progress: 'stale', routes: 'ready', skills: 'stale', council: 'ready' });
  assert.deepEqual(allPresentStale.inbox, []);
  assert.equal(inboxEmptyText(allPresentStale.inboxSources), '已采集的来源里无待处理;沿用旧数据:谱系进度、技能审计');
  assert.equal(inboxBadgeState([], allPresentStale.inboxSources), 'queued');
  const refreshReady = deriveConsole({
    overview: { skills: { skills: 4, warn: 0, error: 0 } },
    progress: { calls: [] },
    at: 1,
  }, { rows: [] });
  assert.deepEqual(refreshReady.inboxSources, { progress: 'ready', routes: 'absent', skills: 'ready', council: 'absent' });

  // 旧两参调用仍可用:三个新源一律 absent,不发明条目
  const legacy = deriveConsole({ overview: {}, progress: { calls: [] }, at: 0 }, { rows: [] });
  assert.deepEqual(legacy.inbox, []);
  assert.equal(legacy.inboxSources.routes, 'absent');

  // sortInbox 稳定:同档同源保插入序
  const sorted = sortInbox([
    { id: 'b', type: 'warning', source: 'council', title: 'b', description: '', timestamp: '', actionText: '' },
    { id: 'a', type: 'warning', source: 'council', title: 'a', description: '', timestamp: '', actionText: '' },
    { id: 'e', type: 'error', source: 'progress', title: 'e', description: '', timestamp: '', actionText: '' },
  ]);
  assert.deepEqual(sorted.map((it) => it.id), ['e', 'b', 'a']);
});

test('W16 AttentionInbox 副标题与空态由来源状态算出;四源全 ready 且空才说「无待处理」', () => {
  const allReady = { progress: 'ready', routes: 'ready', skills: 'ready', council: 'ready' } as const;
  const someAbsent = { progress: 'ready', routes: 'absent', skills: 'absent', council: 'ready' } as const;
  assert.equal(inboxEmptyText(allReady), '无待处理');
  assert.equal(inboxEmptyText(someAbsent), '已采集的来源里无待处理;未采集:路由台账、技能审计');
  assert.equal(inboxEmptyText({ progress: 'absent', routes: 'absent', skills: 'absent', council: 'absent' }), '四个来源均未采集,待处理数未知');
  assert.match(inboxSubtitle(allReady), /^来源:谱系进度、路由台账、技能审计、评审台账 · 失败 > 警告 > 在跑$/);
  assert.match(inboxSubtitle(someAbsent), /未采集:路由台账、技能审计/);
  const someStale = { progress: 'ready', routes: 'stale', skills: 'ready', council: 'ready' } as const;
  assert.match(inboxSubtitle(someStale), /更新失败、沿用旧数据:路由台账/);
  assert.equal(inboxEmptyText(someStale), '已采集的来源里无待处理;沿用旧数据:路由台账');
  // 徽章:空 + 有来源缺席 → 不是绿色 done
  assert.equal(inboxBadgeState([], allReady), 'done');
  assert.equal(inboxBadgeState([], someAbsent), 'queued');
  assert.equal(inboxBadgeState([], { progress: 'absent', routes: 'absent', skills: 'absent', council: 'absent' }), 'queued');
  assert.equal(inboxBadgeState([{ type: 'error' }], allReady), 'failed');

  const emptyHtml = renderToStaticMarkup(React.createElement(AttentionInbox, { items: [], sources: allReady }));
  assert.match(emptyHtml, /无待处理/);
  assert.match(emptyHtml, /0 待处理/);
  assert.doesNotMatch(emptyHtml, /badge--failed/, '空态徽章不能是失败态');
  assert.match(emptyHtml, /badge--done/);
  const partialHtml = renderToStaticMarkup(React.createElement(AttentionInbox, { items: [], sources: someAbsent }));
  assert.doesNotMatch(partialHtml, />无待处理</, '有来源缺席时不能无条件说无待处理');
  assert.match(partialHtml, /未采集:路由台账、技能审计/);
  assert.match(partialHtml, /badge--queued/, '空 + 缺席 → 徽章不是绿色');
  const allAbsentHtml = renderToStaticMarkup(React.createElement(AttentionInbox, { items: [], sources: { progress: 'absent', routes: 'absent', skills: 'absent', council: 'absent' } }));
  assert.match(allAbsentHtml, /待处理数未知/);
  assert.doesNotMatch(allAbsentHtml, /badge--done/);

  // 源锁:组件与派生层都不得出现静态单源声明 / 「待审批」(含否定形式)
  const here = dirname(fileURLToPath(import.meta.url));
  const strip = (f: string): string => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
  for (const f of [join(here, '..', 'components', 'console', 'AttentionInbox.tsx'), join(here, 'console-live.tsx')]) {
    const src = strip(f);
    assert.doesNotMatch(src, /来自 \/api\/swarm\/progress/, `${f} 又写死了单一来源`);
    assert.doesNotMatch(src, /待审批|待批/, `「待审批」今天没有控制台级数据源,不得出现在收件箱文案里:${f}`);
  }
});
