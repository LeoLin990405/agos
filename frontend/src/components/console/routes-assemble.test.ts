import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import {
  ASSEMBLE_CONFIRM_COPY,
  ASSEMBLE_COPY,
  ASSEMBLE_EMPTY_COPY,
  ASSEMBLE_HOW_COPY,
  assembleContractViolations,
  deriveAssembleView,
  DISPATCH_BUTTON_COPY,
  DISPATCH_CONFIRM_CHECK_COPY,
  DISPATCH_COPY,
  DISPATCH_EMPTY_COPY,
  DISPATCH_NO_TOOLS_COPY,
  dispatchContractViolations,
  formatViolations,
  isDispatchOfThis,
  KNOWN_ASSEMBLE_NOTES,
  KNOWN_TURN_NOTES,
  KNOWN_BACKEND_ERRORS,
  LISTED_RUN_HEADER_COPY,
  LIVE_DISPATCH_OFF_COPY,
  NOTE_DISTINCT_COPY,
  NOTE_POOL_SMALL_COPY,
  OUTCOME_CONFIRM_COPY,
  parseAssemblePlan,
  parseDispatchRun,
  RETIRED_ASSEMBLE_NOTES,
  RETIRED_DISPATCH_NOTES,
  ROLE_SET,
  sourceCopy,
  RETIRED_BEFORE_TS,
  STATUS_HAS_RUN_COPY,
  STATUS_LEDGER_UNREAD_COPY,
  STATUS_NOT_RUN_COPY,
  STATUS_OTHER_RUN_COPY,
  STATUS_OTHER_RUN_UNKNOWN_COPY,
  STATUS_RUN_INVALID_COPY,
  TURN_TEXT_PREFIX,
  TURN_TEXT_REDACTED_COPY,
  TURN_ERROR_UNKNOWN_COPY,
  TURN_TEXT_LIMIT,
  turnFailureCopy,
} from './routes-assemble.ts';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, '..', '..');
const read = (name: string): string => readFileSync(join(here, name), 'utf8');
const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');

const ROLES = [
  { role: 'planner', model: 'glm-5.2' },
  { role: 'implementer', model: 'qwen3.8-max' },
  { role: 'reviewer', model: 'minimax-m3' },
];
const OLD_TS = 1787418402450; // 台账第 12 行的真实 ts,早于改名
const GOOD_ASSEMBLE = { id: 'asm-1', ts: OLD_TS, dispatched: false, note: ASSEMBLE_COPY, live: LIVE_DISPATCH_OFF_COPY, roles: ROLES, notes: [NOTE_DISTINCT_COPY] };
const TURNS = [
  { role: 'planner', model: 'glm-5.2', ok: true, text: '三步' },
  { role: 'implementer', model: 'qwen3.8-max', ok: true, text: '' },
  { role: 'reviewer', model: 'minimax-m3', ok: false, error: 'TIMEOUT' },
];
const GOOD_DISPATCH = {
  id: 'dsp-1',
  ref: 'asm-1',
  ts: OLD_TS,
  dispatched: true,
  sessionSwitched: false,
  outcome: null,
  note: DISPATCH_COPY,
  live: LIVE_DISPATCH_OFF_COPY,
  tools: DISPATCH_NO_TOOLS_COPY,
  turns: TURNS,
};
const fields = (list: { field: string }[]): string[] => list.map((v) => v.field);

// ── 契约校验:后端是断言方,前端是校验方 ──────────────────────────────

test('parseAssemblePlan: 契约相符才解析，不发明角色，不搬运文案，distinct 与 notes 按同屏 roles 算', () => {
  assert.equal(parseAssemblePlan(null), null);
  const plan = parseAssemblePlan({ assemble: GOOD_ASSEMBLE });
  assert.equal(plan?.dispatched, false);
  assert.equal(plan?.roles[2]?.model, 'minimax-m3');
  assert.equal('note' in (plan ?? {}), false);
  assert.equal('live' in (plan ?? {}), false);
  assert.equal(plan?.distinct, true);
  assert.deepEqual(plan?.notes, [NOTE_DISTINCT_COPY]);
  // 评审=实现:distinct 算出 false;后端硬塞的「generation≠review」与同屏矛盾,不显示,只计数(第二轮 [13])。
  const same = parseAssemblePlan({ assemble: { ...GOOD_ASSEMBLE, distinct: true, roles: [ROLES[0], ROLES[1], { role: 'reviewer', model: 'qwen3.8-max' }] } });
  assert.equal(same?.distinct, false);
  // 规则句「必须不同」照显;事实句「候选池不够」只在同屏确实相同时显示(第三轮 [30]:后端小池时两句并出)。
  assert.deepEqual(same?.notes, [NOTE_DISTINCT_COPY]);
  assert.equal(same?.unknownNotes, 0);
  assert.deepEqual(parseAssemblePlan({ assemble: { ...GOOD_ASSEMBLE, roles: [ROLES[0], ROLES[1], { role: 'reviewer', model: 'qwen3.8-max' }], notes: [NOTE_DISTINCT_COPY, NOTE_POOL_SMALL_COPY] } })?.notes, [NOTE_DISTINCT_COPY, NOTE_POOL_SMALL_COPY]);
  const bigPool = parseAssemblePlan({ assemble: { ...GOOD_ASSEMBLE, notes: [NOTE_DISTINCT_COPY, NOTE_POOL_SMALL_COPY] } });
  assert.deepEqual(bigPool?.notes, [NOTE_DISTINCT_COPY]);
  assert.equal(bigPool?.unknownNotes, 1);
  // source 只认两个值;id/pick 必须合形;label 镜像 labels.js 的 class 形状。
  assert.equal(parseAssemblePlan({ assemble: { ...GOOD_ASSEMBLE, source: 'garbage' } })?.source, undefined);
  assert.equal(sourceCopy(undefined), '来源未采集');
  assert.equal(parseAssemblePlan({ assemble: { ...GOOD_ASSEMBLE, id: 'asm-1 已接入本跳会话' } })?.id, undefined);
  assert.equal(parseAssemblePlan({ assemble: { ...GOOD_ASSEMBLE, pick: '已接入本跳会话并换了模型' } })?.pick, undefined);
  assert.equal(parseAssemblePlan({ assemble: { ...GOOD_ASSEMBLE, label: '已接入本跳会话并换了模型，已改仓库' } })?.label, undefined);
  assert.equal(parseAssemblePlan({ assemble: { ...GOOD_ASSEMBLE, label: 'sql' } })?.label, 'sql');
  assert.equal(parseAssemblePlan({ assemble: { ...GOOD_ASSEMBLE, label: 'abcdefghijklmnop~0123456789ab' } })?.label, 'abcdefghijklmnop~0123456789ab');
});

/**
 * ⚠️ 这条原来叫「keeps dispatched=false」：喂 dispatched:true，断言解析出 false。
 * 它锁住的是「把矛盾证据静默抹掉」—— 后端才知道有没有派出去，前端硬写等于把
 * 唯一能发现问题的信号删掉（2026-08-23 审查 P1-1）。现在反过来：不符就是违约。
 */
test('组装：后端说 dispatched=true 是违约，不是被改写成 false', () => {
  const payload = { assemble: { ...GOOD_ASSEMBLE, dispatched: true, note: '已派活' } };
  const violations = assembleContractViolations(payload);
  assert.deepEqual(fields(violations), ['dispatched', 'note']);
  assert.equal(parseAssemblePlan(payload), null);
  assert.match(formatViolations('组装', violations), /dispatched 应为 false，实为 true/);
});

test('试跑：后端如实报「换了会话、outcome ok」是违约，不是被改写成 false/null', () => {
  const lying = { dispatch: { ...GOOD_DISPATCH, sessionSwitched: true, outcome: 'ok' } };
  assert.deepEqual(fields(dispatchContractViolations(lying)), ['sessionSwitched', 'outcome']);
  assert.equal(parseDispatchRun(lying), null);
  assert.deepEqual(fields(dispatchContractViolations({ dispatch: { ...GOOD_DISPATCH, dispatched: false } })), ['dispatched']);
  assert.deepEqual(fields(dispatchContractViolations({ dispatch: { ...GOOD_DISPATCH, note: '已派活到当前会话并换了模型' } })), ['note']);
  assert.deepEqual(fields(dispatchContractViolations({ dispatch: { ...GOOD_DISPATCH, tools: '已执行工具' } })), ['tools']);
  const run = parseDispatchRun({ dispatch: GOOD_DISPATCH });
  assert.equal(run?.dispatched, true);
  assert.equal(run?.sessionSwitched, false);
  assert.equal(run?.outcome, null);
  assert.equal(run?.ref, 'asm-1');
  assert.equal('note' in (run ?? {}), false);
  assert.equal('tools' in (run ?? {}), false);
});

test('缺席也是违约：后端一个字不说，前端不替它印保证', () => {
  const { note: _n, live: _l, tools: _t, ...bare } = GOOD_DISPATCH;
  assert.deepEqual(fields(dispatchContractViolations({ dispatch: bare })), ['note', 'live', 'tools']);
  const { sessionSwitched: _s, ...noSwitch } = GOOD_DISPATCH;
  assert.deepEqual(fields(dispatchContractViolations({ dispatch: noSwitch })), ['sessionSwitched']);
  const { note: _an, ...bareAssemble } = GOOD_ASSEMBLE;
  assert.deepEqual(fields(assembleContractViolations({ assemble: bareAssemble })), ['note']);
  assert.match(formatViolations('试跑', dispatchContractViolations({ dispatch: bare })), /note 应为 .*实为 缺席/);
});

test('角色表 / 回合表不合形是违约，不是「没有记录」', () => {
  // 第二轮 [5][11]:roles:[] 原来零违约、解析 null,屏上就印「还没有组装提案」而台账里明明有那条记录。
  assert.deepEqual(fields(assembleContractViolations({ assemble: { ...GOOD_ASSEMBLE, roles: [] } })), ['roles']);
  assert.deepEqual(fields(assembleContractViolations({ assemble: { ...GOOD_ASSEMBLE, roles: 'x' } })), ['roles']);
  assert.deepEqual(fields(dispatchContractViolations({ dispatch: { ...GOOD_DISPATCH, turns: [] } })), ['turns']);
  // 第二轮 [2]:roles[].model / pick 经 POST candidates 注入任意句子。模型名必须是 ASCII slug,角色名只认四个。
  assert.deepEqual(fields(assembleContractViolations({ assemble: { ...GOOD_ASSEMBLE, roles: [ROLES[0], { role: 'implementer', model: '已接入本跳会话并换了模型' }] } })), ['roles[1]']);
  assert.deepEqual(fields(assembleContractViolations({ assemble: { ...GOOD_ASSEMBLE, roles: [{ role: '已改仓库', model: 'glm-5.2' }] } })), ['roles[0]']);
  assert.deepEqual(fields(dispatchContractViolations({ dispatch: { ...GOOD_DISPATCH, turns: [{ role: 'planner', model: 'glm-5.2', ok: 'yes' }] } })), ['turns[0]']);
  assert.deepEqual([...ROLE_SET].sort(), ['fixer', 'implementer', 'planner', 'reviewer']);
  // 行间(第三轮 [4][7]):三个核心角色各恰好一次;ok:true 不得同时带 error。
  assert.deepEqual(fields(assembleContractViolations({ assemble: { ...GOOD_ASSEMBLE, roles: [ROLES[1], { role: 'reviewer', model: 'qwen3.8-max' }, { role: 'implementer', model: 'glm-5.2' }] } })), ['roles']);
  assert.deepEqual(fields(assembleContractViolations({ assemble: { ...GOOD_ASSEMBLE, roles: [ROLES[0], ROLES[1]] } })), ['roles']);
  assert.deepEqual(fields(dispatchContractViolations({ dispatch: { ...GOOD_DISPATCH, turns: [{ role: 'planner', model: 'glm-5.2', ok: true, error: 'TIMEOUT', text: 'x' }, TURNS[1], TURNS[2]] } })), ['turns[0]']);
  // fixer 可选,不影响。
  assert.deepEqual(assembleContractViolations({ assemble: { ...GOOD_ASSEMBLE, roles: [...ROLES, { role: 'fixer', model: 'step-3.7-flash' }] } }), []);
});

test('退役表逐字钉死；历史行经退役表仍能解析；中间那版「尚未试跑」从未落盘，不在表里', () => {
  assert.deepEqual([...RETIRED_ASSEMBLE_NOTES], ['组装提案，不是已派活']);
  assert.deepEqual([...RETIRED_DISPATCH_NOTES], ['本次是派活测试，未换本跳会话模型']);
  assert.deepEqual(assembleContractViolations({ assemble: { ...GOOD_ASSEMBLE, note: '组装提案，不是已派活' } }), []);
  assert.deepEqual(dispatchContractViolations({ dispatch: { ...GOOD_DISPATCH, note: '本次是派活测试，未换本跳会话模型' } }), []);
  assert.equal(assembleContractViolations({ assemble: { ...GOOD_ASSEMBLE, note: '组装提案，尚未试跑' } }).length, 1);
  // 退役值只对改名前落盘的记录有效;改名后还带旧文案 = 后端没更新(第三轮 [23])。
  const late = assembleContractViolations({ assemble: { ...GOOD_ASSEMBLE, ts: RETIRED_BEFORE_TS + 1, note: '组装提案，不是已派活' } });
  assert.deepEqual(fields(late), ['note']);
  assert.match(late[0]?.expected ?? '', /退役文案只对/);
  assert.deepEqual(fields(assembleContractViolations({ assemble: { ...GOOD_ASSEMBLE, ts: undefined, note: '组装提案，不是已派活' } })), ['note']);
});

test('unwrap 只按信封键下钻：三种真实信封与裸记录看到同一层；键在场但为 null = 没有记录', () => {
  // 第二轮 [0][28]:按外层字段猜把 POST 信封当成了记录。这里钉住「外层带 dispatched 的信封」照样解析。
  const postAssemble = { decision: { id: 'dec-1' }, assemble: GOOD_ASSEMBLE, dispatched: false };
  const postDispatch = { dispatch: GOOD_DISPATCH, assemble: GOOD_ASSEMBLE, dispatched: true, sessionSwitched: false, outcome: null, note: DISPATCH_COPY, live: LIVE_DISPATCH_OFF_COPY };
  const getRoutes = { decisions: [], assemble: GOOD_ASSEMBLE, dispatch: GOOD_DISPATCH, stats: {} };
  for (const env of [postAssemble, getRoutes, GOOD_ASSEMBLE]) {
    assert.deepEqual(assembleContractViolations(env), [], JSON.stringify(Object.keys(env)));
    assert.equal(parseAssemblePlan(env)?.id, 'asm-1');
  }
  for (const env of [postDispatch, getRoutes, GOOD_DISPATCH]) {
    assert.deepEqual(dispatchContractViolations(env), [], JSON.stringify(Object.keys(env)));
    assert.equal(parseDispatchRun(env)?.ref, 'asm-1');
  }
  // 键在场但 null(台账里还没有那条记录):零违约、解析 null —— 不是违约,也不把外层当记录。
  assert.deepEqual(assembleContractViolations({ decisions: [], assemble: null, dispatch: null, stats: {} }), []);
  assert.equal(parseAssemblePlan({ assemble: null, dispatched: false }), null);
  assert.deepEqual(dispatchContractViolations({ assemble: GOOD_ASSEMBLE, dispatch: null, dispatched: true }), []);
  // 键缺席且值自己不带 roles/turns:也是「没有记录」,不是 4+7 条「缺席」违约(第三轮 [0][10][20])。
  assert.deepEqual(assembleContractViolations({ decisions: [], stats: {} }), []);
  assert.deepEqual(dispatchContractViolations({ decisions: [], stats: {} }), []);
  assert.deepEqual(dispatchContractViolations({ decision: {}, assemble: GOOD_ASSEMBLE, dispatched: false }), []);
  assert.deepEqual(assembleContractViolations({ dispatch: GOOD_DISPATCH, note: DISPATCH_COPY, live: LIVE_DISPATCH_OFF_COPY }), []);
  const v = deriveAssembleView({ payload: { decisions: [], stats: {} }, proposed: null, localRun: null });
  assert.deepEqual([v.assembleViolations, v.dispatchViolations], [[], []]);
  assert.equal(v.showAssembleEmpty, true);
  // 记录里塞一个同名嵌套键:两条路径都只下钻一层,判定一致(第二轮 [3])。
  const nested = { ...GOOD_ASSEMBLE, dispatched: true, note: '已派活', assemble: GOOD_ASSEMBLE };
  assert.deepEqual(fields(assembleContractViolations({ assemble: nested })), ['dispatched', 'note']);
  assert.deepEqual(fields(assembleContractViolations({ decisions: [], assemble: nested })), ['dispatched', 'note']);
});

test('违约预览有上限且按原串计数，alert 区不是后端文本的搬运带', () => {
  const long = { dispatch: { ...GOOD_DISPATCH, note: 'X'.repeat(20000) } };
  const text = formatViolations('试跑', dispatchContractViolations(long));
  assert.ok(text.length < 400, `违约文案长度 ${text.length}`);
  assert.match(text, /共 20000 字符/);
  assert.match(formatViolations('试跑', dispatchContractViolations({ dispatch: { ...GOOD_DISPATCH, note: 'Y'.repeat(79) } })), /实为 "Y{79}"；?/);
});

test('回合文案：note 只认表内那句，error 码译成中文，原型链键不泄漏，text 截 400', () => {
  assert.deepEqual([...KNOWN_TURN_NOTES], ['宿主未配置该模型']);
  assert.equal(turnFailureCopy({ note: '宿主未配置该模型' }), '宿主未配置该模型');
  assert.equal(turnFailureCopy({ note: '已接入本跳会话并换了模型', error: 'BAD_OUTPUT' }), '没有产出可见文本（旧码，原因未拆分）');
  // 2026-08-23 拆码:四个新码各有译文;PROVIDER_ERROR 带供应商码译文;max-tokens 点明截断;认不出的供应商码不带。
  assert.equal(turnFailureCopy({ error: 'NO_TEXT', finish: 'max-tokens' }), '没有产出文本块，输出被 maxTokens 上限截断');
  assert.equal(turnFailureCopy({ error: 'TOOL_CALL' }), '模型试图调用工具');
  assert.equal(turnFailureCopy({ error: 'UNPARSEABLE' }), '输出不是约定的 JSON');
  assert.equal(turnFailureCopy({ error: 'PROVIDER_ERROR', providerCode: 'QUOTA' }), '供应商报错（额度用尽）');
  assert.equal(turnFailureCopy({ error: 'PROVIDER_ERROR', providerCode: '__proto__' }), '供应商报错');
  assert.equal(turnFailureCopy({ error: 'PROVIDER_ERROR', providerCode: 'Invalid API Key: sk-abc' }), '供应商报错');
  assert.equal(turnFailureCopy({ error: 'WHATEVER_NEW' }), TURN_ERROR_UNKNOWN_COPY);
  assert.equal(turnFailureCopy({}), TURN_ERROR_UNKNOWN_COPY);
  // 第二轮 [1]:`'__proto__' in {}` 为真,原来会把 Object.prototype 当文案渲染,React 直接抛错。
  for (const key of ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
    assert.equal(turnFailureCopy({ error: key }), TURN_ERROR_UNKNOWN_COPY, key);
  }
  const tr = parseDispatchRun({ dispatch: { ...GOOD_DISPATCH, turns: [
    { role: 'planner', model: 'glm-5.2', ok: false, error: 'PROVIDER_ERROR', providerCode: 'AUTH', finish: 'error', blockTypes: [], usage: { inputTokens: 1, outputTokens: 0 } },
    { role: 'implementer', model: 'qwen3.8-max', ok: true, text: 'x', finish: 'stop', blockTypes: ['text'], usage: { inputTokens: 1, outputTokens: 5 } },
    TURNS[2],
  ] } });
  assert.equal(tr?.turns[0]?.failure, '供应商报错（鉴权失败）');
  assert.equal(tr?.turns[1]?.ok, true);
  const run = parseDispatchRun({ dispatch: { ...GOOD_DISPATCH, turns: [
    { role: 'planner', model: 'glm-5.2', ok: false, note: '已接入本跳会话并换了模型', error: '__proto__' },
    { role: 'implementer', model: 'qwen3.8-max', ok: true, text: 'Y'.repeat(5000), note: '随便' },
    { role: 'reviewer', model: 'minimax-m3', ok: true, text: '通过' },
  ] } });
  assert.equal(run?.turns[0]?.failure, TURN_ERROR_UNKNOWN_COPY);
  assert.equal(typeof run?.turns[0]?.failure, 'string');
  assert.equal(run?.turns[1]?.text?.length, TURN_TEXT_LIMIT + 1);
  assert.equal(run?.turns[1]?.redacted, false);
  assert.equal('note' in (run?.turns[1] ?? {}), false);
  assert.equal('error' in (run?.turns[0] ?? {}), false);
  // ok:true 且 text 为空:按契约只可能是后端敏感信息闸扣下(第三轮 [2]),不是「模型出了空文本」。
  const good = parseDispatchRun({ dispatch: GOOD_DISPATCH });
  assert.equal(good?.turns[1]?.redacted, true);
  assert.equal(good?.turns[1]?.text, undefined);
  assert.equal(TURN_TEXT_REDACTED_COPY, '产出文本被敏感信息闸扣下，未采集');
  assert.equal(TURN_TEXT_PREFIX, '原话 · ');
});

// ── 派生视图:所有时态句与空态门都在这里算,七个场景逐一钉死 ──────────────

const envelope = (assemble: unknown, dispatch: unknown): { assemble: unknown; dispatch: unknown } => ({ assemble, dispatch });
const plan = parseAssemblePlan({ assemble: GOOD_ASSEMBLE })!;
const run = parseDispatchRun({ dispatch: GOOD_DISPATCH })!;

test('isDispatchOfThis 是唯一谓词：两边 id 都在场且相等；缺席一边就不是', () => {
  assert.equal(isDispatchOfThis(plan, run), true);
  assert.equal(isDispatchOfThis({ ...plan, id: undefined }, { ...run, ref: undefined }), false);
  assert.equal(isDispatchOfThis(plan, { ...run, ref: 'asm-0' }), false);
  assert.equal(isDispatchOfThis(null, run), false);
  assert.equal(isDispatchOfThis(plan, null), false);
});

test('场景①台账里这条提案已有试跑 → 「已有试跑记录」，列表抬头不说「本次」，空态都不显示', () => {
  const v = deriveAssembleView({ payload: envelope(GOOD_ASSEMBLE, GOOD_DISPATCH), proposed: null, localRun: null });
  assert.equal(v.statusCopy, STATUS_HAS_RUN_COPY);
  assert.equal(v.dispatchHeader, LISTED_RUN_HEADER_COPY);
  assert.equal(v.dispatchOfThis?.ref, 'asm-1');
  assert.equal(v.showAssembleEmpty, false);
  assert.equal(v.showDispatchEmpty, false);
  assert.deepEqual([v.assembleViolations, v.dispatchViolations], [[], []]);
});

test('场景②组装记录违约 → 只有 alert；不显示提案、不显示空态、没有时态句', () => {
  const v = deriveAssembleView({ payload: envelope({ ...GOOD_ASSEMBLE, dispatched: true }, GOOD_DISPATCH), proposed: null, localRun: null });
  assert.deepEqual(fields(v.assembleViolations), ['dispatched']);
  assert.equal(v.assemble, null);
  assert.equal(v.statusCopy, undefined);
  assert.equal(v.showAssembleEmpty, false);
  assert.equal(v.showDispatchEmpty, false);
  assert.equal(v.dispatchOfThis, null);
});

test('场景③试跑记录违约 → 时态句说「契约不符，状态未采集」，整行不再印「未接入本跳会话换模」', () => {
  // 第二轮 [7] / 第三轮 [37]:原来试跑违约时同屏仍印「尚未试跑」与保证句。
  const v = deriveAssembleView({ payload: envelope(GOOD_ASSEMBLE, { ...GOOD_DISPATCH, sessionSwitched: true }), proposed: null, localRun: null });
  assert.deepEqual(fields(v.dispatchViolations), ['sessionSwitched']);
  assert.equal(v.statusCopy, STATUS_RUN_INVALID_COPY);
  assert.equal(v.assembleLine, `${ASSEMBLE_COPY}。${STATUS_RUN_INVALID_COPY}。`);
  assert.doesNotMatch(v.assembleLine ?? '', /未接入本跳会话换模/);
  assert.equal(v.dispatchOfThis, null);
  assert.equal(v.showDispatchEmpty, false);
  // 第三轮 [6][25]:本地刚跑完、指向本提案的试跑压过台账那条的违约;保证句回来,alert 仍在。
  const local = { ...run, id: 'dsp-9' };
  const w = deriveAssembleView({ payload: envelope(GOOD_ASSEMBLE, { ...GOOD_DISPATCH, sessionSwitched: true }), proposed: null, localRun: local });
  assert.equal(w.statusCopy, STATUS_HAS_RUN_COPY);
  assert.equal(w.dispatchHeader, DISPATCH_COPY);
  assert.equal(w.dispatchOfThis, local);
  assert.equal(w.assembleLine, `${ASSEMBLE_COPY}。${LIVE_DISPATCH_OFF_COPY}。${STATUS_HAS_RUN_COPY}。`);
  assert.deepEqual(fields(w.dispatchViolations), ['sessionSwitched']);
});

test('场景④台账试跑属于另一条提案 → 「没有可见记录；属于另一条提案 asm-0」；ref 认不出 → 「归属未采集」', () => {
  // 第二轮 [9][22]:空态句与「属于另一条」同屏互斥。第三轮 [3][8][9]:推不出「没跑过」,推不出「另一条」。
  const v = deriveAssembleView({ payload: envelope(GOOD_ASSEMBLE, { ...GOOD_DISPATCH, ref: 'asm-0' }), proposed: null, localRun: null });
  assert.equal(v.statusCopy, `${STATUS_OTHER_RUN_COPY} asm-0`);
  assert.doesNotMatch(v.statusCopy ?? '', /尚未试跑/);
  assert.equal(v.dispatchOfThis, null);
  assert.equal(v.showDispatchEmpty, false);
  const u = deriveAssembleView({ payload: envelope(GOOD_ASSEMBLE, { ...GOOD_DISPATCH, ref: 'asm-0 已接入' }), proposed: null, localRun: null });
  assert.equal(u.statusCopy, STATUS_OTHER_RUN_UNKNOWN_COPY);
});

test('场景⑤读失败（无 payload）→ 无空态、无时态句；本地有提案时说「台账未读到」而不是「尚未试跑」', () => {
  // 第二轮 [6]:原来 status=error 时照样印「还没有组装提案」「还没有试跑记录」。第三轮 [26]:台账读不到照印「尚未试跑」。
  const v = deriveAssembleView({ payload: undefined, proposed: null, localRun: null });
  assert.equal(v.ledgerLoaded, false);
  assert.equal(v.showAssembleEmpty, false);
  assert.equal(v.showDispatchEmpty, false);
  assert.equal(v.statusCopy, undefined);
  assert.deepEqual([v.assembleViolations, v.dispatchViolations], [[], []]);
  const w = deriveAssembleView({ payload: undefined, proposed: plan, localRun: null });
  assert.equal(w.statusCopy, STATUS_LEDGER_UNREAD_COPY);
  assert.equal(w.showDispatchEmpty, false);
  const x = deriveAssembleView({ payload: undefined, proposed: plan, localRun: run });
  assert.equal(x.statusCopy, STATUS_HAS_RUN_COPY);
});

test('场景⑥读到空台账 → 「还没有组装提案」；有提案没试跑 → 「尚未试跑」+「还没有试跑记录」', () => {
  const empty = deriveAssembleView({ payload: envelope(null, null), proposed: null, localRun: null });
  assert.equal(empty.showAssembleEmpty, true);
  assert.equal(empty.showDispatchEmpty, false);
  const noRun = deriveAssembleView({ payload: envelope(GOOD_ASSEMBLE, null), proposed: null, localRun: null });
  assert.equal(noRun.statusCopy, STATUS_NOT_RUN_COPY);
  assert.equal(noRun.assembleLine, `${ASSEMBLE_COPY}。${LIVE_DISPATCH_OFF_COPY}。${STATUS_NOT_RUN_COPY}。`);
  assert.equal(noRun.showAssembleEmpty, false);
  assert.equal(noRun.showDispatchEmpty, true);
});

test('场景⑦本地刚组装的新提案压过台账提案；本地刚跑的试跑抬头说「本次」；「台账最近一次」只看台账', () => {
  // 第二轮 [12]:「台账最近一次试跑属于另一条提案 X」里的 X 不能取本地状态。
  const fresh = { ...plan, id: 'asm-2' };
  const v = deriveAssembleView({ payload: envelope(GOOD_ASSEMBLE, GOOD_DISPATCH), proposed: fresh, localRun: null });
  assert.equal(v.assemble?.id, 'asm-2');
  assert.equal(v.statusCopy, `${STATUS_OTHER_RUN_COPY} asm-1`);
  assert.equal(v.dispatchOfThis, null);
  assert.equal(v.showDispatchEmpty, false);
  const local = { ...run, ref: 'asm-2', id: 'dsp-2' };
  const ran = deriveAssembleView({ payload: envelope(GOOD_ASSEMBLE, GOOD_DISPATCH), proposed: fresh, localRun: local });
  assert.equal(ran.statusCopy, STATUS_HAS_RUN_COPY);
  assert.equal(ran.dispatchHeader, DISPATCH_COPY);
  assert.equal(ran.dispatchOfThis, local);
  // 本地试跑指向的不是屏上这条提案(例如用户换了提案):不挂上去,抬头也不说「本次」。
  const stale = deriveAssembleView({ payload: envelope(GOOD_ASSEMBLE, null), proposed: fresh, localRun: { ...run, ref: 'asm-1' } });
  assert.equal(stale.dispatchOfThis, null);
  assert.equal(stale.statusCopy, STATUS_NOT_RUN_COPY);
  assert.equal(stale.showDispatchEmpty, false);
});

// ── 写端点锁 ②:本文件 AST —— fetch 只许作直接被调函数,且实参是白名单字面量 ──────

const WRITE_PATHS = ['/api/agos/routes/outcome', '/api/agos/routes/assemble', '/api/agos/routes/assemble/dispatch'];
const NETWORK_IDS = new Set(['fetch', 'XMLHttpRequest', 'sendBeacon', 'Request', 'WebSocket', 'EventSource', 'importScripts']);

const sourceFile = (file: string): ts.SourceFile =>
  ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, /\.(tsx|jsx)$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

test('routes-assemble.ts：fetch 只出现为直接被调函数、实参是白名单字面量；没有别名、属性访问或其他网络原语', () => {
  const sf = sourceFile(join(here, 'routes-assemble.ts'));
  const literalArgs: string[] = [];
  const offenders: string[] = [];
  const visit = (node: ts.Node, parent?: ts.Node): void => {
    if (ts.isIdentifier(node) && NETWORK_IDS.has(node.text)) {
      const isDirectCallee = parent !== undefined && ts.isCallExpression(parent) && parent.expression === node;
      if (node.text !== 'fetch' || !isDirectCallee) offenders.push(`${node.text}@${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
      else {
        const arg = (parent as ts.CallExpression).arguments[0];
        if (arg !== undefined && ts.isStringLiteral(arg) && WRITE_PATHS.includes(arg.text)) literalArgs.push(arg.text);
        else offenders.push(`fetch 实参不是白名单字面量@${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
      }
    }
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && NETWORK_IDS.has(node.text)) offenders.push(`string ${node.text}`);
    if (ts.isPropertyAccessExpression(node) && NETWORK_IDS.has(node.name.text)) offenders.push(`prop .${node.name.text}`);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) offenders.push('dynamic import');
    ts.forEachChild(node, (child) => visit(child, node));
  };
  visit(sf);
  assert.deepEqual(offenders, []);
  assert.deepEqual(literalArgs.sort(), [...WRITE_PATHS].sort());
});

// ── 写端点锁 ③:仓级 —— TypeScript 扫描器取字面量,不被注释/字符串骗 ──────

/** 只读端点:任何文件都可以 GET。写端点只许在 routes-assemble.ts。 */
const ROUTES_GET_RE = /^\/api\/agos\/routes(\/outcomes)?(\?[^ ]*)?$/;

function listSources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) { out.push(...listSources(full)); continue; }
    if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(name)) out.push(full);
  }
  return out;
}

type Lit = { text: string; dynamic: boolean; concat: boolean; line: number };
/** 字符串/模板字面量;并标记它是否参与了 + 拼接、数组字面量或模板串(这三种都能把路径拼出来)。 */
function literalsOf(file: string): Lit[] {
  const sf = sourceFile(file);
  const out: Lit[] = [];
  const line = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
  const inConcat = (n: ts.Node): boolean => {
    for (let p = n.parent; p !== undefined; p = p.parent) {
      if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.PlusToken) return true;
      if (ts.isArrayLiteralExpression(p)) return true;
      if (ts.isCallExpression(p) || ts.isStatement(p)) return false;
    }
    return false;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) out.push({ text: node.text, dynamic: false, concat: inConcat(node), line: line(node) });
    else if (ts.isTemplateExpression(node)) {
      out.push({ text: node.head.text, dynamic: true, concat: false, line: line(node) });
      for (const span of node.templateSpans) out.push({ text: span.literal.text, dynamic: true, concat: false, line: line(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

test('仓级锁：src/**（含测试、.js/.mts）与 vite.config.ts 任何字面量不得指向 decide 端点；路由路径不得拼接；写路径只许在 routes-assemble.ts；生产代码不得 import 测试文件', () => {
  const files = [...listSources(srcRoot), join(srcRoot, '..', 'vite.config.ts')];
  assert.ok(files.length > 60, `只扫到 ${files.length} 个文件`);
  const offenders: string[] = [];
  const writeSites = new Set<string>();
  for (const file of files) {
    const rel = relative(srcRoot, file);
    // 生产代码 import 一个 .test. 模块 = 把测试里的夹具 fetch 带进生产(第三轮 [36])。
    if (!/\.test\.[cm]?[jt]sx?$/.test(rel)) {
      const sf = sourceFile(file);
      const visitImports = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && /\.test(\.[cm]?[jt]sx?)?$/.test(node.moduleSpecifier.text)) offenders.push(`${rel}: import 了测试模块 ${node.moduleSpecifier.text}`);
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && /\.test(\.[cm]?[jt]sx?)?$/.test(node.arguments[0].text)) offenders.push(`${rel}: 动态 import 了测试模块`);
        ts.forEachChild(node, visitImports);
      };
      visitImports(sf);
    }
    // 测试文件只受 decide 规则约束(它们是普通 ESM,能被生产代码 import —— 第二轮 [22]);
    // 拼接/写路径规则对测试里的夹具不适用。
    const isTest = /\.test\.[cm]?[jt]sx?$/.test(rel);
    for (const { text, dynamic, concat, line } of literalsOf(file)) {
      const where = `${rel}:${line}`;
      if (/routes\/decide|^\/?decide$/i.test(text)) offenders.push(`${where}: ${JSON.stringify(text)}`);
      if (isTest) continue;
      const at = text.indexOf('/api/agos/routes');
      if (at < 0) continue;
      const path = text.slice(at);
      if (at > 0 && !/^https?:\/\/[^/]+$/.test(text.slice(0, at))) offenders.push(`${where}: 路由路径不得嵌在别的文本里 ${JSON.stringify(text)}`);
      if (dynamic) offenders.push(`${where}: 路由端点不得用模板串拼 ${JSON.stringify(text)}`);
      if (concat) offenders.push(`${where}: 路由端点不得参与 + 拼接或数组 ${JSON.stringify(text)}`);
      if (ROUTES_GET_RE.test(path)) continue;
      if (!WRITE_PATHS.includes(path)) offenders.push(`${where}: 未知路由端点 ${JSON.stringify(text)}`);
      writeSites.add(rel);
    }
  }
  assert.deepEqual(offenders, []);
  assert.deepEqual([...writeSites], ['components/console/routes-assemble.ts']);
});

test('RoutesView 不发请求：AST 里没有 fetch/XHR/Request/form/动态 import，GET 只走 useResource，网络模块只许两个', () => {
  const file = join(here, 'RoutesView.tsx');
  const sf = sourceFile(file);
  const hits: string[] = [];
  const imports: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && NETWORK_IDS.has(node.text)) hits.push(`identifier ${node.text}`);
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && NETWORK_IDS.has(node.text)) hits.push(`string ${node.text}`);
    if (ts.isPropertyAccessExpression(node) && NETWORK_IDS.has(node.name.text)) hits.push(`prop .${node.name.text}`);
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText();
      if (['form', 'iframe', 'img', 'link', 'script', 'object', 'embed'].includes(tag)) hits.push(`jsx <${tag}>`);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) hits.push('dynamic import');
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'createElement') hits.push('createElement');
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  assert.deepEqual(hits, []);
  const networkCapable = imports.filter((m) => !/^react$|^@\/components\/ui\/|\.\/routes-model$/.test(m));
  assert.deepEqual(networkCapable.sort(), ['./routes-assemble', '@/lib/useResource']);
  const text = readFileSync(file, 'utf8');
  assert.match(text, /const fetchRoutes = async \(url: string, signal: AbortSignal\): Promise<RoutesPayload> =>\n  parseRoutesPayload\(await fetchJsonResource<unknown>\(url, signal\)\);/);
  assert.equal((text.match(/useResource</g) ?? []).length, 1);
  assert.match(text, /useResource<RoutesPayload>\(\{ url: '\/api\/agos\/routes', fetcher: fetchRoutes \}\)/);
});

// ── 视图只渲染派生对象与冻结常量 ──────────────────────────────────────

test('RoutesView 只渲染 deriveAssembleView 的结果与冻结常量，不自己判断，不搬运载荷文案', () => {
  const view = stripComments(read('RoutesView.tsx'));
  assert.match(view, /const view = deriveAssembleView\(\{ payload, proposed, localRun \}\)/);
  // 视图里不许再出现任何自行判断:没有 parse*/…ContractViolations 调用,没有 .ref === / .id === 比较。
  assert.doesNotMatch(view, /parseAssemblePlan|parseDispatchRun|ContractViolations\(/);
  assert.doesNotMatch(view, /\.ref ===|=== (view\.)?assemble\.id/);
  assert.doesNotMatch(view, /\.(note|live|tools)\b/);
  for (const key of ['showAssembleEmpty', 'showDispatchEmpty', 'assembleLine', 'dispatchHeader', 'dispatchOfThis', 'assembleViolations', 'dispatchViolations']) {
    assert.match(view, new RegExp(`view\\.${key}`), `view.${key} 没有用到`);
  }
  assert.match(view, /role="alert"[\s\S]{0,160}formatViolations\('组装', view\.assembleViolations\)/);
  assert.match(view, /role="alert"[\s\S]{0,160}formatViolations\('试跑', view\.dispatchViolations\)/);
  assert.match(view, /role=\{note\.tone === 'error' \? 'alert' : 'status'\}/);
  assert.match(view, /<p className="surface-quiet">\{view\.assembleLine\}<\/p>/);
  assert.doesNotMatch(view, /\{view\.statusCopy\}/);
  assert.match(view, /\{view\.dispatchHeader\}。\{DISPATCH_NO_TOOLS_COPY\}。/);
  assert.doesNotMatch(view, /DISPATCH_EMPTY_COPY\}。\{DISPATCH_COPY\}/);
  assert.match(view, /surface-lede">\s*outcome 为 null 时显示待回填，不是成功或失败。只报告。\s*<\/p>/);
  assert.equal((view.match(/\} catch \(caught\) \{/g) ?? []).length, 3);
  for (const key of ['ASSEMBLE_EMPTY_COPY', 'ASSEMBLE_HOW_COPY', 'ASSEMBLE_CONFIRM_COPY', 'DISPATCH_NO_TOOLS_COPY', 'DISPATCH_CONFIRM_CHECK_COPY', 'DISPATCH_EMPTY_COPY', 'DISPATCH_BUTTON_COPY']) {
    assert.match(view, new RegExp(`\\{${key}\\}`), `${key} 没有渲染`);
  }
  assert.match(view, /row\.ok \? \(row\.redacted \? TURN_TEXT_REDACTED_COPY : `\$\{TURN_TEXT_PREFIX\}\$\{row\.text \?\? ''\}`\) : row\.failure/);
  // 失败分支也刷新台账;试跑失败放掉本地提案(第三轮 [5][21])。
  assert.equal((view.match(/resource\.refresh\(\);/g) ?? []).length, 5);
  assert.match(view, /setDispatchNote\(\{ tone: 'error', text: posted\.error \}\);\s*setProposed\(null\);\s*setLocalRun\(null\);\s*resource\.refresh\(\);/);
  assert.match(view, /sourceCopy\(row\.source\)/);
  assert.match(view, /只报告/);
});

// ── 词汇 ──────────────────────────────────────────────────────────────

test('冻结常量逐字钉死（与插件 assemble.js / dispatch.js 镜像；runtime 测试另钉「相等」）；同一物一个名', () => {
  assert.equal(ASSEMBLE_COPY, '组装提案，只定角色不执行');
  assert.equal(ASSEMBLE_EMPTY_COPY, '还没有组装提案');
  assert.equal(LIVE_DISPATCH_OFF_COPY, '未接入本跳会话换模');
  assert.equal(DISPATCH_COPY, '本次是三角色试跑，未换本跳会话模型');
  assert.equal(DISPATCH_NO_TOOLS_COPY, '三角色只出文本，不改仓库');
  assert.equal(DISPATCH_EMPTY_COPY, '还没有试跑记录');
  assert.deepEqual([...KNOWN_ASSEMBLE_NOTES], ['generation≠review：评审模型必须和实现模型不同', '候选池不够，未能做到 generation≠review']);
  // 前端自有文案:「本跳会话」一个名,不再混用「当前会话」(第二轮 [36])。
  assert.equal(OUTCOME_CONFIRM_COPY, '确认回填人工胜负，不换本跳会话模型');
  assert.equal(DISPATCH_CONFIRM_CHECK_COPY, '确认三角色试跑：只出文本，不换本跳会话模型，不记胜负');
  assert.equal(STATUS_HAS_RUN_COPY, '已有试跑记录（只出文本，未换本跳会话模型）');
  assert.equal(LISTED_RUN_HEADER_COPY, '这条提案的试跑记录（只出文本，未换本跳会话模型）');
  assert.doesNotMatch([STATUS_HAS_RUN_COPY, LISTED_RUN_HEADER_COPY, STATUS_OTHER_RUN_COPY].join(''), /未换会话[^模]/);
  assert.deepEqual([...KNOWN_BACKEND_ERRORS].slice(0, 3), ['组装提案需要 confirm:true', '三角色试跑需要 confirm:true', '请求指定的提案不是台账最新一条，拒绝试跑']);
  assert.equal(ASSEMBLE_CONFIRM_COPY, '确认只生成组装提案，不换本跳会话模型');
  assert.equal(DISPATCH_BUTTON_COPY, '开始三角色试跑');
  assert.doesNotMatch(stripComments(read('RoutesView.tsx')), /当前会话/);
  // 组装的真实后果写在屏上:后端会写一条决策行;界面本身不调 decide(第二轮 [40])。
  assert.match(ASSEMBLE_HOW_COPY, /写一条待回填决策行/);
  assert.match(ASSEMBLE_HOW_COPY, /界面本身不调用 decide 接口/);
  // 类别句不带时态词。
  assert.doesNotMatch(ASSEMBLE_COPY, /尚未|已经|本次/);
});

test('「派活」只许出现在 AgosComputer.tsx（swarm 子代理）；组装侧与全仓其余文案零「派活」', () => {
  // 仓级词汇锁:扫 src/** 的字符串字面量与 JSX 文本(剥注释),不靠 grep。退役表与测试文件除外。
  const offenders: string[] = [];
  for (const file of listSources(srcRoot)) {
    const rel = relative(srcRoot, file);
    if (/\.test\.[cm]?[jt]sx?$/.test(rel)) continue;
    const sf = sourceFile(file);
    const visit = (node: ts.Node): void => {
      const isText = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isJsxText(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node);
      if (isText && node.text.includes('派活')) {
        const retired = [...RETIRED_ASSEMBLE_NOTES, ...RETIRED_DISPATCH_NOTES].includes(node.text);
        if (!(rel === 'components/stage/AgosComputer.tsx' || (rel === 'components/console/routes-assemble.ts' && retired))) {
          offenders.push(`${rel}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${JSON.stringify(node.text.trim().slice(0, 40))}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  assert.deepEqual(offenders, []);
  assert.match(readFileSync(join(srcRoot, 'components', 'stage', 'AgosComputer.tsx'), 'utf8'), /派活之后这里会逐批列出进度/);
  // 概览入口的句子是正向断言,不只是「没有派活」(第二轮 [34])。
  assert.match(readFileSync(join(srcRoot, 'pages', 'console-live.tsx'), 'utf8'), /路由组装是提案，只定角色不执行。三角色试跑需确认，只出文本、不开子代理。/);
});
