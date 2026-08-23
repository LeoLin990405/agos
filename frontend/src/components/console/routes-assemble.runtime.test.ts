/**
 * 运行时锁 + 真实信封锁。
 *
 * 单独一个文件,因为钩子必须装在 **import 之前**:模块顶层 `const f = fetch` 之类的别名在
 * 求值时就抓住了原生 fetch,事后换 globalThis.fetch 记不到它(第二轮对抗验证 [14][24][39])。
 * node --test 每个文件一个进程,所以这里先装钩子再动态 import。
 *
 * 「真实信封」:用插件自己的 assembleLive / dispatchTeam / listRoutes 产生 POST 与 GET 的响应,
 * 喂给前端的校验与解析。第二轮 [0][28][38] 就是因为前端测试用手造的 {assemble: 记录}
 * 而插件测试钉住「外层带 dispatched」的真实信封 —— 两套各自全绿,线上每次组装/试跑都报违约。
 * 这条测试跑的是插件真源的代码,零网络、零模型调用。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

type Call = { method: string; url: string; bodyKeys: string[] };
const calls: Call[] = [];
let reply: (url: string) => unknown = () => ({});
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const bodyKeys = typeof init?.body === 'string' ? Object.keys(JSON.parse(init.body) as Record<string, unknown>).sort() : [];
  calls.push({ method: (init?.method ?? 'GET').toUpperCase(), url, bodyKeys });
  const body = reply(url);
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}) as typeof fetch;
assert.notEqual(globalThis.fetch, originalFetch);

// 钩子已装,现在才 import 被测模块。
const fe = await import('./routes-assemble.ts');

const PLUGIN = join(homedir(), '.dsh', 'profiles', 'desktop', 'plugins', 'dsh-agos-router', 'lib');
const assembleJs = await import(join(PLUGIN, 'assemble.js')) as {
  assembleLive: (input: unknown, deps: unknown) => Promise<Record<string, unknown>>;
  ASSEMBLE_COPY: string; LIVE_DISPATCH_OFF_COPY: string; GENERATION_NEQ_REVIEW_COPY: string; POOL_TOO_SMALL_COPY: string; ASSEMBLE_EMPTY_COPY: string;
};
const dispatchJs = await import(join(PLUGIN, 'dispatch.js')) as {
  dispatchTeam: (assemble: unknown, input: unknown, deps: unknown) => Promise<Record<string, unknown>>;
  DISPATCH_COPY: string; DISPATCH_NO_TOOLS_COPY: string; MODEL_UNRESOLVED_COPY: string; DISPATCH_EMPTY_COPY: string; DISPATCH_CONFIRM_COPY: string; ASSEMBLE_MISMATCH_COPY: string;
};
const ledgerJs = await import(join(PLUGIN, 'ledger.js')) as {
  appendLine: (file: string, record: unknown) => unknown;
  listRoutes: (file: string, limit?: number) => Record<string, unknown>;
  readLedgerLines: (file: string) => unknown[];
};

const DECISION = { id: 'dec-1-test', pick: 'qwen3.8-max', role: 'implementer', label: 'coding', source: 'fallback', confidence: 0, reason: 'x' };

/** 走插件真源:POST /assemble 的信封、POST /assemble/dispatch 的信封、GET /routes 的信封。 */
async function realEnvelopes(): Promise<{ assemblePost: Record<string, unknown>; dispatchPost: Record<string, unknown>; routesGet: Record<string, unknown> }> {
  const dir = mkdtempSync(join(tmpdir(), 'agos-envelope-'));
  const file = join(dir, 'route-outcome.jsonl');
  const assemblePost = await assembleJs.assembleLive({ task: '', candidates: [] }, {
    decide: async () => DECISION,
    readRows: () => ledgerJs.readLedgerLines(file),
    append: (record: unknown) => ledgerJs.appendLine(file, record),
  });
  const dispatchPost = await dispatchJs.dispatchTeam(assemblePost.assemble, { confirm: true, ref: (assemblePost.assemble as { id: string }).id, task: '' }, {
    append: (record: unknown) => ledgerJs.appendLine(file, record),
    streamRole: async (input: { role: string }) => (input.role === 'implementer' ? (() => { const e = new Error('x') as Error & { code: string }; e.code = 'BAD_OUTPUT'; throw e; })() : `${input.role} 文本`),
  });
  const routesGet = ledgerJs.listRoutes(file, 50);
  return { assemblePost, dispatchPost, routesGet };
}

test('冻结常量与插件真源逐字相同(两边都钉了字面量,这里钉「相等」)', () => {
  assert.equal(fe.ASSEMBLE_COPY, assembleJs.ASSEMBLE_COPY);
  assert.equal(fe.LIVE_DISPATCH_OFF_COPY, assembleJs.LIVE_DISPATCH_OFF_COPY);
  assert.equal(fe.ASSEMBLE_EMPTY_COPY, assembleJs.ASSEMBLE_EMPTY_COPY);
  assert.equal(fe.NOTE_DISTINCT_COPY, assembleJs.GENERATION_NEQ_REVIEW_COPY);
  assert.equal(fe.NOTE_POOL_SMALL_COPY, assembleJs.POOL_TOO_SMALL_COPY);
  assert.equal(fe.DISPATCH_COPY, dispatchJs.DISPATCH_COPY);
  assert.equal(fe.DISPATCH_NO_TOOLS_COPY, dispatchJs.DISPATCH_NO_TOOLS_COPY);
  assert.equal(fe.DISPATCH_EMPTY_COPY, dispatchJs.DISPATCH_EMPTY_COPY);
  assert.deepEqual([...fe.KNOWN_TURN_NOTES], [dispatchJs.MODEL_UNRESOLVED_COPY]);
  // 后端会发的错误串都在前端白名单里(不然会被前端换成状态码)。
  for (const s of [dispatchJs.DISPATCH_CONFIRM_COPY, dispatchJs.ASSEMBLE_MISMATCH_COPY, assembleJs.ASSEMBLE_EMPTY_COPY]) assert.ok(fe.KNOWN_BACKEND_ERRORS.includes(s), s);
});

test('插件真实信封:POST /assemble、POST /assemble/dispatch、GET /routes 三种都能被前端解析且零违约', async () => {
  const { assemblePost, dispatchPost, routesGet } = await realEnvelopes();
  // 形状钉住:外层确实带契约字段 —— 这正是按外层字段猜会翻车的原因。
  assert.equal(assemblePost.dispatched, false);
  assert.equal(dispatchPost.dispatched, true);
  assert.equal(dispatchPost.sessionSwitched, false);
  assert.equal('tools' in dispatchPost, false);
  assert.ok(Array.isArray(routesGet.decisions));

  assert.deepEqual(fe.assembleContractViolations(assemblePost), []);
  const plan = fe.parseAssemblePlan(assemblePost);
  assert.ok(plan, 'POST /assemble 信封解析失败');
  assert.match(plan.id ?? '', /^asm-\d+$/);
  assert.equal(plan.roles.length, 3);
  assert.equal(plan.distinct, true);
  assert.deepEqual(plan.notes, [fe.NOTE_DISTINCT_COPY]);
  assert.equal(plan.unknownNotes, 0);

  assert.deepEqual(fe.dispatchContractViolations(dispatchPost), []);
  const run = fe.parseDispatchRun(dispatchPost);
  assert.ok(run, 'POST /assemble/dispatch 信封解析失败');
  assert.equal(run.ref, plan.id);
  assert.deepEqual(run.turns.map((t) => [t.role, t.ok, t.failure ?? t.text]), [
    ['planner', true, 'planner 文本'],
    ['implementer', false, '没有产出可见文本'],
    ['reviewer', true, 'reviewer 文本'],
  ]);

  assert.deepEqual(fe.assembleContractViolations(routesGet), []);
  assert.deepEqual(fe.dispatchContractViolations(routesGet), []);
  assert.equal(fe.parseAssemblePlan(routesGet)?.id, plan.id);
  assert.equal(fe.parseDispatchRun(routesGet)?.ref, plan.id);

  // 派生视图在真实 GET 信封上:这条提案「已有试跑记录」,空态都不显示。
  const view = fe.deriveAssembleView({ payload: routesGet, proposed: null, localRun: null });
  assert.equal(view.statusCopy, fe.STATUS_HAS_RUN_COPY);
  assert.equal(view.dispatchHeader, fe.LISTED_RUN_HEADER_COPY);
  assert.equal(view.showAssembleEmpty, false);
  assert.equal(view.showDispatchEmpty, false);
  assert.equal(view.dispatchOfThis?.ref, plan.id);
});

test('台账真实历史行(改名前的文案)经退役表仍零违约', () => {
  const file = join(homedir(), '.dsh', 'logs', 'route-outcome.jsonl');
  const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  const assemble = rows.find((r) => r.kind === 'assemble');
  const dispatch = rows.find((r) => r.kind === 'dispatch');
  assert.ok(assemble && dispatch, '台账里应有 2026-08-23 首跳的 assemble 与 dispatch 行');
  assert.deepEqual(fe.assembleContractViolations(assemble), []);
  assert.deepEqual(fe.dispatchContractViolations(dispatch), []);
  assert.equal(fe.parseDispatchRun(dispatch)?.ref, fe.parseAssemblePlan(assemble)?.id);
});

test('运行时锁:三个写函数真实发出的 (method, url, body 键) 恰好等于白名单;未确认/ref 不合形时零请求', async () => {
  const { assemblePost, dispatchPost } = await realEnvelopes();
  reply = (url) => (url.endsWith('/assemble/dispatch') ? dispatchPost : url.endsWith('/assemble') ? assemblePost : {});
  calls.length = 0;
  // 空 task 与非空 task 各跑一遍:只在某种实参下才走的分支也逃不掉(第三轮 [34])。
  for (const task of ['', '给这段 SQL 做一次规划、实现和独立评审']) {
    calls.length = 0;
    const results = await Promise.all([
      fe.postRouteOutcome({ ref: 'dec-1', result: 'ok', confirm: true }),
      fe.postAssembleProposal({ task, confirm: true }),
      fe.postAssembleDispatch({ task, ref: (assemblePost.assemble as { id: string }).id, confirm: true }),
    ]);
    assert.ok(results.every((r) => r.ok), JSON.stringify(results));
    assert.deepEqual(
      calls.map((c) => `${c.method} ${c.url} {${c.bodyKeys.join(',')}}`).sort(),
      [
        'POST /api/agos/routes/assemble {confirm,task}',
        'POST /api/agos/routes/assemble/dispatch {confirm,ref,task}',
        'POST /api/agos/routes/outcome {ref,result,source}',
      ],
      `task=${JSON.stringify(task)}`,
    );
  }
  for (const c of calls) assert.doesNotMatch(c.url, /decide/i);

  calls.length = 0;
  const silent = await Promise.all([
    fe.postRouteOutcome({ ref: 'dec-1', result: 'ok', confirm: false }),
    fe.postAssembleProposal({ task: '', confirm: false }),
    fe.postAssembleDispatch({ task: '', ref: 'asm-1', confirm: false }),
    fe.postAssembleDispatch({ task: '', ref: '', confirm: true }),
    fe.postAssembleDispatch({ task: '', ref: 'asm-1 已接入本跳会话', confirm: true }),
  ]);
  assert.deepEqual(calls, []);
  assert.ok(silent.every((r) => !r.ok));
});

test('运行时锁:违约响应、200+{error}、非对象响应、非 2xx、JSON 解析失败 各走各的错误分支', async () => {
  const { dispatchPost } = await realEnvelopes();
  const ref = (dispatchPost.dispatch as { ref: string }).ref;
  // 违约要放在信封**内层**的记录上;改外层字段没有意义 —— unwrap 只按信封键下钻。
  reply = () => ({ ...dispatchPost, dispatch: { ...(dispatchPost.dispatch as Record<string, unknown>), sessionSwitched: true } });
  let r = await fe.postAssembleDispatch({ task: '', ref, confirm: true });
  assert.ok(!r.ok && /试跑响应与冻结契约不符：sessionSwitched 应为 false，实为 true/.test(r.error), JSON.stringify(r));

  // 后端错误串只认白名单里的几句;别的只给状态码与错误码,不搬运(第三轮 [22])。
  reply = () => ({ error: '还没有组装提案', code: 'ASSEMBLE_REQUIRED' });
  r = await fe.postAssembleDispatch({ task: '', ref, confirm: true });
  assert.deepEqual(r, { ok: false, error: '还没有组装提案' });
  reply = () => ({ error: '已接入本跳会话并换了模型', code: 'WHATEVER' });
  r = await fe.postAssembleDispatch({ task: '', ref, confirm: true });
  assert.deepEqual(r, { ok: false, error: 'HTTP 200 · 错误码 WHATEVER' });

  reply = () => 'html';
  const p = await fe.postAssembleProposal({ task: '', confirm: true });
  assert.deepEqual(p, { ok: false, error: '组装响应不是对象' });

  const hooked = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: false, status: 409, json: async () => ({ error: '请求指定的提案不是台账最新一条，拒绝试跑', code: 'ASSEMBLE_MISMATCH' }) }) as unknown as Response) as typeof fetch;
  r = await fe.postAssembleDispatch({ task: '', ref, confirm: true });
  assert.deepEqual(r, { ok: false, error: '请求指定的提案不是台账最新一条，拒绝试跑' });
  assert.ok(fe.KNOWN_BACKEND_ERRORS.includes(dispatchJs.ASSEMBLE_MISMATCH_COPY));
  globalThis.fetch = (async () => ({ ok: false, status: 502, json: async () => { throw new Error('not json'); } }) as unknown as Response) as typeof fetch;
  r = await fe.postAssembleDispatch({ task: '', ref, confirm: true });
  assert.deepEqual(r, { ok: false, error: 'HTTP 502' });
  globalThis.fetch = hooked;
});
