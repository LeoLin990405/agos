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
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

// 2026-08-24 起插件源码与前端同仓:夹具直接 import 仓内真源 plugins/dsh-agos-router/lib(不再读 profile 的部署副本,
// 否则写端读端分离——测的是上次部署的版本)。here = frontend/src/components/console。
const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'plugins', 'dsh-agos-router', 'lib');
const assembleJs = await import(join(PLUGIN, 'assemble.js')) as {
  assembleLive: (input: unknown, deps: unknown) => Promise<Record<string, unknown>>;
  ASSEMBLE_COPY: string; LIVE_DISPATCH_OFF_COPY: string; GENERATION_NEQ_REVIEW_COPY: string; POOL_TOO_SMALL_COPY: string; ASSEMBLE_EMPTY_COPY: string;
};
const dispatchJs = await import(join(PLUGIN, 'dispatch.js')) as {
  dispatchTeam: (assemble: unknown, input: unknown, deps: unknown) => Promise<Record<string, unknown>>;
  DISPATCH_COPY: string; DISPATCH_NO_TOOLS_COPY: string; MODEL_UNRESOLVED_COPY: string; IMPLEMENTER_RETRY_COPY: string; DISPATCH_EMPTY_COPY: string; DISPATCH_CONFIRM_COPY: string; ASSEMBLE_MISMATCH_COPY: string;
};
const ledgerJs = await import(join(PLUGIN, 'ledger.js')) as {
  appendLine: (file: string, record: unknown) => unknown;
  listRoutes: (file: string, limit?: number) => Record<string, unknown>;
  readLedgerLines: (file: string) => unknown[];
};

const DECISION = { id: 'dec-1-test', pick: 'qwen3.8-max', role: 'implementer', label: 'coding', source: 'fallback', confidence: 0, reason: 'x' };

/** 走插件真源:POST /assemble 的信封、POST /assemble/dispatch 的信封、GET /routes 的信封。 */
const shadowJs = await import(join(PLUGIN, 'shadow.js')) as {
  shadowDecide: (body: unknown, deps: { select?: (input: unknown) => Promise<unknown>; append: (r: unknown) => void }) => Promise<Record<string, unknown>>;
  buildShadowLinkRecord: (input: unknown) => Record<string, unknown>;
};

async function realEnvelopes(): Promise<{ assemblePost: Record<string, unknown>; dispatchPost: Record<string, unknown>; routesGet: Record<string, unknown>; shadowPost: Record<string, unknown>; shadowLinkPost: Record<string, unknown> }> {
  const dir = mkdtempSync(join(tmpdir(), 'agos-envelope-'));
  const file = join(dir, 'route-outcome.jsonl');
  // W17:影子响应也用插件真实生产者(select 是桩,零模型)
  const shadowPost = await shadowJs.shadowDecide(
    { items: ['写一份 README'], hosts: [{ name: 'leo-01', kind: 'remote', model: 'deepseek-v4-flash', tags: ['linux'], maxConcurrency: 6, enabled: true, ok: true, inflight: 0 }], chosen: ['leo-01'], tag: '', label: '' },
    { select: async () => ({ pick: 'leo-01', role: 'implementer', confidence: 0.7, reason: '唯一候选', label: 'docs' }), append: (record: unknown) => ledgerJs.appendLine(file, record) },
  );
  const shadowLinkPost = shadowJs.buildShadowLinkRecord({ ref: shadowPost.id, batchId: 'b-f785f00d-8463-4369-9a02-4bf6dc7e3024', hosts: ['leo-01'] });
  const assemblePost = await assembleJs.assembleLive({ task: '', candidates: [] }, {
    decide: async () => DECISION,
    readRows: () => ledgerJs.readLedgerLines(file),
    append: (record: unknown) => ledgerJs.appendLine(file, record),
  });
  const dispatchPost = await dispatchJs.dispatchTeam(assemblePost.assemble, { confirm: true, ref: (assemblePost.assemble as { id: string }).id, task: '' }, {
    append: (record: unknown) => ledgerJs.appendLine(file, record),
    // 插件 2026-08-23 拆码后 implementer 失败形状:NO_TEXT + detail(finish/blockTypes/usage)。
    streamRole: async (input: { role: string }) => (input.role === 'implementer'
      ? (() => { const e = new Error('x') as Error & { code: string; detail: unknown }; e.code = 'NO_TEXT'; e.detail = { blockTypes: ['reasoning'], finish: 'max-tokens', usage: { inputTokens: 100, outputTokens: 256 } }; throw e; })()
      : { text: `${input.role} 文本`, detail: { blockTypes: ['text'], finish: 'stop', usage: { inputTokens: 10, outputTokens: 5 } } }),
  });
  const routesGet = ledgerJs.listRoutes(file, 50);
  return { assemblePost, dispatchPost, routesGet, shadowPost, shadowLinkPost };
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
  assert.deepEqual([...fe.KNOWN_TURN_NOTES], [dispatchJs.MODEL_UNRESOLVED_COPY, dispatchJs.IMPLEMENTER_RETRY_COPY]);
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
    ['implementer', false, '没有产出文本块，输出被 maxTokens 上限截断'],
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

test('自带旧文案台账夹具经退役表仍零违约，不读取个人账本', async () => {
  const { routesGet } = await realEnvelopes();
  const rows = routesGet.decisions as Record<string, unknown>[];
  const assemble = { ...rows.find((r) => r.kind === 'assemble'), note: fe.RETIRED_ASSEMBLE_NOTES[0], ts: fe.RETIRED_BEFORE_TS - 1 };
  const dispatch = { ...rows.find((r) => r.kind === 'dispatch'), note: fe.RETIRED_DISPATCH_NOTES[0], ts: fe.RETIRED_BEFORE_TS - 1 };
  assert.deepEqual(fe.assembleContractViolations(assemble), []);
  assert.deepEqual(fe.dispatchContractViolations(dispatch), []);
  assert.equal(fe.parseDispatchRun(dispatch)?.ref, fe.parseAssemblePlan(assemble)?.id);
});

test('运行时锁:三个写函数真实发出的 (method, url, body 键) 恰好等于白名单;未确认/ref 不合形时零请求', async () => {
  const { assemblePost, dispatchPost, shadowPost, shadowLinkPost } = await realEnvelopes();
  reply = (url) => (url.endsWith('/assemble/dispatch') ? dispatchPost : url.endsWith('/assemble') ? assemblePost : url.endsWith('/shadow/link') ? shadowLinkPost : url.endsWith('/shadow') ? shadowPost : {});
  calls.length = 0;
  // 空 task 与非空 task 各跑一遍:只在某种实参下才走的分支也逃不掉(第三轮 [34])。
  for (const task of ['', '给这段 SQL 做一次规划、实现和独立评审']) {
    calls.length = 0;
    const results = await Promise.all([
      fe.postRouteOutcome({ ref: 'dec-1', result: 'ok', confirm: true }),
      fe.postAssembleProposal({ task, confirm: true }),
      fe.postAssembleDispatch({ task, ref: (assemblePost.assemble as { id: string }).id, confirm: true }),
      fe.postShadowSelection({ items: ['x'], hosts: [{ name: 'leo-01', kind: 'remote', model: 'm', tags: [], maxConcurrency: 1, enabled: true, ok: true, inflight: 0 }], chosen: [], tag: '', label: '', confirm: true }),
      fe.postShadowLink({ ref: 'dec-1', batchId: 'b-1', hosts: ['leo-01'] }),
    ]);
    assert.ok(results.every((r) => r.ok), JSON.stringify(results));
    assert.deepEqual(
      calls.map((c) => `${c.method} ${c.url} {${c.bodyKeys.join(',')}}`).sort(),
      [
        'POST /api/agos/routes/assemble {confirm,task}',
        'POST /api/agos/routes/assemble/dispatch {confirm,ref,task}',
        'POST /api/agos/routes/outcome {ref,result,source}',
        'POST /api/agos/routes/shadow {chosen,hosts,items,label,tag}',
        'POST /api/agos/routes/shadow/link {batchId,hosts,ref}',
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
    fe.postShadowSelection({ items: ['x'], hosts: [], chosen: [], tag: '', label: '', confirm: true }),
    fe.postShadowSelection({ items: [], hosts: [{ name: 'leo-01', kind: 'remote', model: 'm', tags: [], maxConcurrency: 1, enabled: true, ok: true, inflight: 0 }], chosen: [], tag: '', label: '', confirm: true }),
    fe.postShadowSelection({ items: ['x'], hosts: [{ name: 'leo-01', kind: 'remote', model: 'm', tags: [], maxConcurrency: 1, enabled: true, ok: true, inflight: 0 }], chosen: [], tag: '', label: '', confirm: false }),
    fe.postShadowLink({ ref: '', batchId: 'b-1', hosts: [] }),
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

test('W17 超时兜底:响应头挂起/响应体挂起都在 timeoutMs 内转 failed(可能已计费文案);调用方主动中止不冒充超时', async () => {
  // 2026-08-24 P1:服务端与渲染器网络栈都按时收发完整(curl 终止块在场、resource timing 12.7s 收完),
  // 但页面 JS 的 fetch 交付偶发滞留 36s~分钟级 → UI 永停「调用中」且派发按钮禁用。兜底在前端定界。
  const hooked = globalThis.fetch;
  const host = { name: 'leo-01', kind: 'remote', model: 'm', tags: [], maxConcurrency: 1, enabled: true, ok: true, inflight: 0 };
  const input = { items: ['x'], hosts: [host], chosen: [], tag: '', label: '', confirm: true };
  // 头阶段挂起:fetch promise 永不落定,仅按真实 fetch 语义在 signal 中止时 reject AbortError
  const hangHeaders = ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }))) as typeof fetch;
  globalThis.fetch = hangHeaders;
  let r = await fe.postShadowSelection(input, undefined, 25);
  assert.deepEqual(r, { ok: false, error: fe.SHADOW_TIMEOUT_COPY });
  // 体阶段挂起:headers 已到(200),json 永不落定;真实 fetch 在 signal 中止时 body 流报错 → json reject
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => ({
    ok: true,
    status: 200,
    json: () => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })),
  }) as unknown as Response) as typeof fetch;
  r = await fe.postShadowSelection(input, undefined, 25);
  assert.deepEqual(r, { ok: false, error: fe.SHADOW_TIMEOUT_COPY });
  // 调用方主动中止不是超时:保持抛出语义,runShadow 的 .catch 接;不冒充超时文案
  globalThis.fetch = hangHeaders;
  const ac = new AbortController();
  const pending = fe.postShadowSelection(input, ac.signal, 5000);
  ac.abort();
  await assert.rejects(pending, (err: unknown) => err instanceof DOMException && err.name === 'AbortError');
  globalThis.fetch = hooked;
  // 常量与文案互相钉住:上限 30 秒写死,文案里的秒数由常量算出,不许各改各的
  assert.equal(fe.SHADOW_TIMEOUT_MS, 30_000);
  assert.ok(fe.SHADOW_TIMEOUT_COPY.includes(`${fe.SHADOW_TIMEOUT_MS / 1000} 秒`), fe.SHADOW_TIMEOUT_COPY);
  assert.match(fe.SHADOW_TIMEOUT_COPY, /计费|台账/, '超时文案必须交代「可能已计费/以台账为准」——failed 不等于没烧额度');
});

test('W17 影子响应走真实生产者:选择器成功/回落/跳过 三态解析与文案;影子行在 GET /routes 里 mode=shadow 且不进 cells', async () => {
  const { shadowPost, routesGet } = await realEnvelopes();
  const decided = fe.parseShadowResponse(shadowPost);
  assert.equal(decided.kind, 'decided');
  if (decided.kind !== 'decided') return;
  assert.equal(decided.pick, 'leo-01'); assert.equal(decided.agreed, true); assert.equal(decided.source, 'selector');
  const copy = fe.shadowSuggestionCopy(decided, () => undefined);
  assert.equal(copy.head, '选择器建议：leo-01（唯一候选）'); assert.equal(copy.relation, '与你勾选的机器一致');
  const fallback = await shadowJs.shadowDecide(
    { items: ['x'], hosts: [{ name: 'leo-01', kind: 'remote', enabled: true }], chosen: [] },
    { select: async () => { const e = new Error('bad') as Error & { code: string }; e.code = 'UNPARSEABLE'; throw e; }, append: () => {} },
  );
  const fb = fe.parseShadowResponse(fallback);
  assert.equal(fb.kind, 'decided');
  if (fb.kind !== 'decided') return;
  assert.equal(fb.pick, null);
  const fbCopy = fe.shadowSuggestionCopy(fb, (r) => (r === 'UNPARSEABLE' ? '选择器输出不是约定的 JSON' : undefined));
  assert.equal(fbCopy.head, '选择器未产出建议（回落：选择器输出不是约定的 JSON）');
  assert.doesNotMatch(fbCopy.head, /选择器建议：/, '回落不得写成建议');
  const skipped = fe.parseShadowResponse(await shadowJs.shadowDecide({ items: ['x'], hosts: [] }, { append: () => {} }));
  assert.equal(skipped.kind, 'skipped');
  assert.throws(() => fe.parseShadowResponse({ id: 'dec-1', source: 'selector' }), /mode/);
  const decisions = routesGet.decisions as Record<string, unknown>[];
  const shadowRow = decisions.find((d) => d.mode === 'shadow');
  assert.ok(shadowRow); assert.equal(shadowRow.pick, 'leo-01');
  const stats = routesGet.stats as { cells: number; shadow: { total: number; suggested: number; agreed: number } };
  assert.deepEqual(stats.shadow, { total: 1, filled: 0, pending: 1, suggested: 1, agreed: 1, filledOk: 0 });
});
