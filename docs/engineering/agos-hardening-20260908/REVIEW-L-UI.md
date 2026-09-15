> Historical Cursor phase review. Later fixes and final acceptance supersede these findings; see REVIEW.md.

# REVIEW-L-UI — E / G / H(console-live) Phase 1

Reviewer: L-ui (frontend / protocol), independent, not an author
Date: 2026-09-08 18:52 Asia/Shanghai
Worktree HEAD: `24bc17e6892839190563defe15ec4ed4b573e934`
Scope: current product code only. Helper files `frontend/src/lib/approval-state.ts`, `session-history.ts`, `connection-health.ts` **do not exist** — Phase 2 not opened.
Method: static read of contract + call sites. No live host, no click-through, no POST against `$events/result`.

Must-keep (from `REVIEW.md` opening matrix):

| ID | Failure trigger | Must-keep |
|---|---|---|
| E | POST fail / timeout / late reply | not resolved; map kept |
| G | hasMore snapshot, late page, session switch | incomplete banner; no fold rewrite |
| H (this review) | refresh fail keeps last payload | inbox must not conclude「无待处理」from stale progress/skills marked ready |

---

## 触发条件与代码位置

### E — 点击即「已放行」，宿主证据尚未到达

**触发 1：映射存在，POST 未完成 / 失败 / 超时。**

1. `$events` 收到 `waterfall` 且 `event === 'approval/request'`，`live.ts` 把 `callId → eventId` 写入 `approvalEvents`。
2. fold 已有 `approval/asked` 且 `outcome === undefined`，`chat-transcript.tsx` 渲染可点的 `ApprovalPanel`。
3. 用户点「允许单次执行」。
4. `ApprovalPanel.handleAllow` **先**把本地 `resolvedState` 设为 `'allowed'`，**再**调用 `onAllow`。
5. `respondApproval` 找到映射后 `void postEventResult(...)`（不 await、不看 HTTP/rpc 结果），立刻 `approvalEvents.delete(callId)`，返回 `true`。
6. 面板已经改成「已放行:本次特权执行已授权」。宿主会话日志的 `approval/decided` 此时尚未到达（也可能永远不到达）。

```34:37:frontend/src/components/chat/ApprovalPanel.tsx
  const handleAllow = () => {
    if (readOnly) return;
    setResolvedState('allowed');
    onAllow?.();
```

```54:60:frontend/src/components/chat/ApprovalPanel.tsx
  if (resolvedState === 'allowed') {
    return (
      <div className="pc-approval-resolved is-allowed" role="status">
        <Dot state="done" size={6} />
        <span>已放行:本次特权执行已授权</span>
```

```282:293:frontend/src/stores/live.ts
export function respondApproval(callId: string | undefined, outcome: 'allowed-once' | 'rejected'): boolean {
  if (callId === undefined || eventClientId === undefined) return false
  const eventId = approvalEvents.get(callId)
  if (eventId === undefined) return false
  void agos.postEventResult({
    clientId: eventClientId as never,
    eventId: eventId as never,
    outcome: { kind: 'result', value: outcome },
  })
  approvalEvents.delete(callId)
  return true
}
```

`postEventResult` 本身是会抛错的 unary（HTTP 非 2xx / rpc 失败都会 throw）。调用方用 `void` 丢掉 Promise，失败只进未处理 rejection，不回写 UI。

```235:237:frontend/src/api-client/index.ts
    async postEventResult(result: RemoteEventResult, signal?: AbortSignal): Promise<void> {
      await postEnvelope('$events/result', result as unknown as object, signal)
```

**结论（E 触发 1）：UI 在宿主证据之前报告成功。** 宿主成功证据是 follow 上的 `approval/decided`（fold 回填 `item.outcome`），不是按钮 click，也不是「POST 已发出」。`REVIEW.md` E 条：map 必须在失败/超时/迟回复时保留 — 当前是发送即删。迟回复无法按同一 `eventId` 重试。

**触发 2：映射不存在，`respondApproval` 返回 false。**

`chat-transcript` 不读返回值。面板已经切到「已放行」。

```640:653:frontend/src/pages/chat-transcript.tsx
  const respond = (outcome: 'allowed-once' | 'rejected') => {
    // 0.1.2: answer the live $events waterfall keyed by the tool callId.
    respondApproval(item.callId ?? item.id, outcome);
  };
  return (
    <div className="message-wrap tl-enter" key={key}>
      <ApprovalPanel
        ...
        onAllow={readOnly ? undefined : () => respond('allowed-once')}
```

`hasApprovalWaterfall` 已导出，审批按钮未用它做 enable。无 waterfall / `$events` 未 ready / `eventClientId` 空，点击仍显示已授权。

**触发 3：同屏两套事实。**

`CommandDeck` 待决数只认 fold：`kind==='approval' && outcome===undefined`。点击后面板说已放行，胶囊仍计 1 条待决，直到 `approval/decided`。这不是「已按宿主确认收敛」，是本地乐观态和 fold 真值打架。

```157:158:frontend/src/components/chat/CommandDeck.tsx
   - 待决数 = 快照里 kind==='approval' 且 outcome===undefined 的条目数
     (fold 由 approval/asked 建条目、approval/decided 回填 outcome)。
```

Host 证据入口：

```311:314:frontend/src/fold/fold.ts
      case 'approval/decided': {
        const item = approvalById.get(asStr(data['id']) ?? '')
        if (item !== undefined) item.outcome = asStr(data['outcome'])
```

若 `approval/decided` 随后到达，父组件会走 `item.outcome !== undefined` 分支，卸掉 `ApprovalPanel`。这条只能覆盖「宿主后来真的写了 decided」。POST 丢失/拒绝/超时且无 decided 时，本地「已放行」一直挂着。未做运行时复现；静态链闭合，按未证实成功处理。

---

### G — snapshot 丢掉 hasMore/header/projections；全局 socket 冒充会话 follow

**触发 1：opening snapshot `hasMore === true`。**

契约要求 snapshot 带 `header` / `cursor` / `records` / `hasMore` / `projections`：

```192:201:frontend/src/contract/api/sessions.ts
export type SessionFollowFrame =
  | {
    type: 'snapshot'
    header: SessionWireHeader
    cursor: number
    records: SessionHistoryRecord[]
    hasMore: boolean
    projections: SessionProjectionBaseline
  }
```

`session/page` 的 `throughSeq` 被定义为对应该 snapshot cursor 的回翻切口：

```217:222:frontend/src/contract/api/sessions.ts
  /**
   * Reads one message-aligned backwards page (session/page). `throughSeq` is the
   * inclusive cut from the corresponding follow snapshot cursor (-1 = empty).
   */
  page(request: RpcRequest<{ address: SessionAddress; throughSeq: number; beforeSeq?: number; maxMessages?: number }>):
```

`onFollowValue` 解析整帧后只用 `records` + `cursor`。`hasMore` / `header` / `projections` 丢弃。然后 `phase: 'live'`。

```153:169:frontend/src/stores/live.ts
function onFollowValue(id: string, value: unknown): void {
  ...
  if (frame.type === 'snapshot') {
    const fold = createFold()
    let lastSeq = frame.cursor
    for (const record of frame.records) {
      const seq = applyRecord(fold, record)
      if (Number.isFinite(seq)) lastSeq = Math.max(lastSeq, seq)
    }
    entry.fold = fold
    entry.lastSeq = lastSeq
    entry.state = { snapshot: fold.snapshot(), phase: 'live', error: undefined, streamOnline }
```

`frontend/src` 内没有任何 `session/page` 产品调用（仅契约、schema、`rpc-map`、`api-client` 注册；`frontend/scripts/smoke.ts` 是脚本不是 SPA）。没有完整性字段，没有未完成横幅。

`ChatPage` 把 `convo.phase === 'live'` 当成历史就绪；窗口 fold 出 0 条还当成空会话：

```269:277:frontend/src/pages/ChatPage.tsx
  const isEmptyConversation = liveMode && (
    !hasActiveLiveSession
    || (convo.phase === 'live' && (convo.snapshot?.items.length ?? 0) === 0)
  );
  ...
    historyReady: convo.phase === 'live',
```

```917:918:frontend/src/pages/ChatPage.tsx
          ) : chatConnectionState === 'empty' || isEmptyConversation ? (
            <EmptyStateHero />
```

**结论（G 触发 1）：snapshot 忽略 hasMore/header/projections。** 首窗被当成全史。`hasMore=true` 时早期记录不可见且无提示。顶栏子代理徽章读的是 **fold** header（`ChatPage.tsx:858`），不是 follow snapshot 的 `SessionWireHeader`。fold 自己也写了 live 路径没有 session 头行（`fold.ts:336`）。投影（title / modelSelection / imageLimits 等）同样未进 conversation state。

**触发 2：`$events` 已开，本会话 `session/follow` 失败或停在重连。**

`streamOnline` / `liveConnectionPhase` **只**由 `$events` 的 `onOpen` / 断线回调改写。`startFollow` 没有独立 online/error，重连回调是空的。`ConversationState.phase === 'error'` 在 live store 里从未被赋过值。

```180:186:frontend/src/stores/live.ts
function startFollow(id: string): () => void {
  return watchStream(
    (signal, onOpen) => agos.stream('session/follow', { request: { address: { kind: 'session', sessionId: id } } }, signal, onOpen),
    (value) => onFollowValue(id, value),
    () => { /* reconnect: the next snapshot rebuilds the fold */ },
  )
}
```

```228:231:frontend/src/stores/live.ts
  stopEvents = watchStream(
    (signal, onOpen) => agos.events(signal, () => { streamOnline = true; liveConnectionPhase = 'online'; convoEmitter.emit(); onOpen?.() }),
    onEventFrame,
    () => { streamOnline = false; liveConnectionPhase = 'offline'; convoEmitter.emit() },
```

`publish()` 把**全局** `streamOnline` 抄进每条 conversation（`live.ts:132`）。`watchStream` 丢流只 `console.error` 后重连（`api-client/index.ts:271-279`），不把 follow 失败写进 store。

聊天顶栏「已连接」绑的是 `streamStore`（即上述全局布尔），不是 follow：

```182:195:frontend/src/pages/ChatPage.tsx
  const isStreamOnline = useSyncExternalStore(streamStore.subscribe, streamStore.getSnapshot);
  const liveConnectionPhase = useSyncExternalStore(liveConnectionStore.subscribe, liveConnectionStore.getSnapshot);
  ...
  const chatConnectionState = deriveChatConnectionState({
    sessionsLoadedAt: liveSessions.loadedAt,
    sessionsError: liveSessions.error,
    sessionCount: liveSessions.rows.length,
    muxPhase: liveConnectionPhase,
  });
```

```886:887:frontend/src/pages/ChatPage.tsx
              <span className={`conn-chip ${isStreamOnline ? 'is-ok' : chatConnectionState === 'connecting' ? 'is-pending' : 'is-off'}`}>
                {isStreamOnline ? '已连接' : chatConnectionState === 'connecting' ? '连接中' : '未连接'}
```

`deriveChatConnectionState` 的输入没有 follow 相位（`chat-connection-state.ts:15-19`）。`$events` online + `session/list` 成功 ⇒ 整页 `ready` / 「已连接」。本会话 follow 可以：从未出 snapshot（transcript 停在「正在折叠…」，`chat-transcript.tsx:766-767`）、出过 snapshot 后断流（仍 `phase:'live'`，旧 fold 当现史）、或 parse 失败直接 `return`（`live.ts:157`）。

**结论（G 触发 2）：健康的全局 socket 可以挡住失败的 session follow。** 传输已连 ≠ 会话订阅正常。`chat-transcript` 的 `phase === 'error'` 分支（769-770）在这条 live 路径上是死代码。

---

### H — stale progress/skills 仍可看起来「无待处理」

`AttentionInbox` 的空态规则本身是对的：四源全 `ready` 且空才说「无待处理」；`stale` 必须点名沿用旧数据。

```39:47:frontend/src/components/console/AttentionInbox.tsx
export function inboxEmptyText(sources: InboxSourceState): string {
  const absent = ALL_SOURCES.filter((k) => sources[k] === 'absent');
  const stale = ALL_SOURCES.filter((k) => sources[k] === 'stale');
  if (absent.length === 0 && stale.length === 0) return '无待处理';
  ...
  return `已采集的来源里无待处理;${bits.join(';')}`;
}
```

缺口在 **derive**：routes/council 吃 `*Stale`，progress/skills 只看「有没有 payload」。

```206:211:frontend/src/pages/console-live.tsx
  const inboxSources: InboxSourceState = {
    progress: t.progress !== undefined ? 'ready' : 'absent',
    routes: extra.routes !== undefined ? (extra.routesStale ? 'stale' : 'ready') : 'absent',
    skills: skillsGroup ? 'ready' : 'absent',
    council: extra.council !== undefined ? (extra.councilStale ? 'stale' : 'ready') : 'absent',
  };
```

`useConsoleLive` 只传 routes/council 的 degraded，不传 progress/overview：

```284:292:frontend/src/pages/console-live.tsx
  const derived = useMemo(() => deriveConsole({
    overview: overviewData,
    progress: progressData,
    at: numAt(overviewData, 'at') ?? overview.at ?? 0,
  }, sessions, {
    routes: routesData, council: councilData,
    routesStale: routesEnabled && routes.status === 'degraded' && routes.data !== undefined,
    councilStale: councilEnabled && council.status === 'degraded' && council.data !== undefined,
  }), [...]);
```

`useResource` 刷新失败保留上一份 data，状态为 `degraded`（`resource.ts:64-71`）。`progressData` 在 degraded 时仍是旧 payload（`console-live.tsx:280-282`）。overview 同理。

**触发：**

1. 四源都成功过。上一份 progress 折不出 inbox 行（空 calls，或全 completed）。上一份 overview 有 `skills` 组且 `drifted` 为 0 / 缺席（`inboxFromSkillsDrift` 不产出）。
2. 本轮 `GET /api/swarm/progress` 和/或 `GET /api/agos/overview` 失败 → status `degraded`，data 仍在。
3. routes/council 若本轮仍成功，它们是 `ready`。
4. `inboxSources.progress` / `.skills` 仍是 `ready`。inbox 为空。
5. `inboxEmptyText` →「无待处理」；`inboxBadgeState` → `done`。

`RealOverview` 在 `progressStatus === 'degraded'` / `overviewStatus === 'degraded'` 时**会**打横幅（`console-live.tsx:387-388`, `450-451`）。横幅和收件箱结论不一致：页顶说更新失败，收件箱绿章「无待处理」。诚实界面的禁止项是后者。

现有测试只锁了 routes/council stale（`console-live.test.ts:243-245`, `270-272`），**没有**「progress/overview degraded 时 sources 不得为 ready」的断言。测试绿不能当 H 已修。

**结论（H）：可以。** stale progress/skills 仍能看起来像「无待处理」。

---

## 协议核对

仓内**没有** `frontend/src/contract/api/approvals.ts`。`ApprovalPanel` 注释指向该文件，注释不是契约。`contract/api/index.ts` 也不导出 approvals 域。

能从本仓合同 + 接线钉死的，只有这些：

| 层 | 证据 | 取值 |
|---|---|---|
| 人工答 waterfall | `respondApproval` 参数；`chat-transcript` 只传这两项 | `'allowed-once' \| 'rejected'` |
| 载体 | `RemoteEventResult.outcome`（`rpc.ts:180-188`） | `{ kind: 'result', value }`；`value` 在 RPC 层是 `unknown`。另有 `{ kind: 'rejected', error }`，那是 listener 拒收瀑布，**不是**业务「拒绝并中止」 |
| 会话日志 | `approval/asked` → `approval/decided`（`fold.ts:299-314`） | `outcome` 是事件里的字符串；UI 对 `'allowed-once'` 显示「已放行(一次)」 |
| YOLO 台账 | `yolo-decisions.ts` | 另有 `'delegate'` 等，是策略/裁判账本，不是人工 `$events/result` 枚举 |

**没有 always-allow 宿主协议。** 不发明。依据：

- 人工 respond 类型只有 `allowed-once | rejected`。
- 直播接线**不传** `onAlwaysAllow`（`chat-transcript.tsx:646-653`）。按钮因此不渲染。
- `onAlwaysAllow` 仍留在 `ApprovalPanel` props 上。谁传谁就画出「本会话永久信任」。原型 `frontend/prototype/js/agos-core.js:102` 有 `always-allow` 文案，那是原型，不是 0.1.2-rc.1 膜。
- shim `ApprovalOutcome = 'approved' \| 'rejected' \| 'cancelled'`（`contract/shims/user-approval-types.ts:4`）是另一套 DSH user-approval 词汇，**不能**用来给 waterfall `value` 加 `always` 或改成 `approved`。

E 的修复不得把 click、`$events/result` HTTP 200、或本地 pending 当成已授权。resolved / 删 map 的条件是本 callId/session 的宿主证据（`approval/decided` 或等价的已证明过期），与 `TASKS.md` shared contract 一致。

G 的 pager 切口是 snapshot `cursor` → `session/page.throughSeq`。乱 invent since-seq 或把晚到页写进别的 session fold，直接打回。

H 的四源状态机已经存在；缺的是 progress/skills 接上 `degraded`，不是再做一套「有 payload 就是 ready」。

---

## 已落地代码的质疑（如有）

Phase 2 点名的三个 helper **未落地**：

- `frontend/src/lib/approval-state.ts`（及 `.test.ts`）
- `frontend/src/lib/session-history.ts`（及 `.test.ts`）
- `frontend/src/lib/connection-health.ts`（及 `.test.ts`）

`TASKS.md` 写 “claimed new” 只表示文件所有权，不表示实现存在。`HANDOFF.md` 也写 Nothing landed yet。

因此：

- 不评审不存在的状态机。
- 不把 `ApprovalPanel` 注释、`TASKS.md` 相位表、分析文档当成已修。
- 作者之后若只加 helper、不改 `ApprovalPanel` 点击抢跑、`respondApproval` 的 `void`+删 map、`onFollowValue` 丢 hasMore、`deriveChatConnectionState` 只看 `$events`、`deriveConsole` 的 progress/skills ready 规则，接线后仍打回。

现码里需要作者不要「顺手带过」的点：

1. `respondApproval === true` 只表示「当时 map 里有 eventId 并且发出了 POST」。把它标成 `accepted` 尚可；标成 `resolved` 不够。
2. `ConversationState.streamOnline` 复用全局 `$events` 旗。G 若只加 banner 但仍用这一个布尔，健康态仍是假的。
3. `console-live.test.ts` 已锁 routes/council stale。只扩文案、不测 progress/overview degraded → sources.stale，算假绿。

---

## 结论（E/G/H：通过/打回/尚早）

| ID | 结论 | 原因 |
|---|---|---|
| **E** | **打回** | 点击即「已放行」；`void` POST；发送即删 map。违反「POST fail/timeout/late reply → not resolved; map kept」。无 helper 可审。 |
| **G** | **打回** | snapshot 忽略 `header/hasMore/projections`；SPA 无 `session/page`；`$events` online 即可「已连接」，follow 失败可被挡住。无完整性横幅。 |
| **H**（console-live 新鲜度） | **打回**（Phase 1） | progress/skills 仍按 payload 在场派生 `ready`。四源空 + 过期 progress/overview ⇒「无待处理」。页级 degraded 横幅不能替 inbox 结论。技能裁剪（matrix 里 H 的 catalog trim）不在本次 L-ui 范围。 |
| Phase 2 helpers | **尚早** | 三个目标文件不存在。有 diff 再审；未证项继续打回。 |

E/G/H 在当前树上都未满足 must-keep。L-ui 不给通过。

---

## Phase 2 — H landed（2026-09-08 18:55 Asia/Shanghai）

Reviewed the **diff**, not the author summary. Files: `skills-evolve.js`, `skills-evolve.test.mjs`, `console-live.tsx`, `console-live.test.ts`, `session-memory.mjs` (pin only). Controller re-run: dsh-agos skills-evolve+session-memory 26 pass; frontend console-live 14 pass. Those greens are not a pass.

H must-keep (`REVIEW.md`): runtime catalog has project skills → those skills survive trim. Fake-green: disabling trim forever, or tests that only restated the author's labeled fixtures.

### 1. Same-name user-root vs project copy — **打回**

Trigger:

1. Host live `skill-catalog` row is `{ name, description }` only. Contract `SkillEntry` has no source (`frontend/src/contract/api/skills.ts:11-17`). Author comment in `skills-evolve.js:167` admits this shape.
2. User-root audit (index.js `catalogOf` via `defaultSkillRootDefs`, user-dsh / user-agents only — `skills-console.js:19-40`) also has that name. This repo's own model is one catalog row per name; project copy can win (`analyzeShadowing`, `skills-console.js:157-218`).
3. Query shortlist does not include that name.
4. `trimRuntimeCatalogEntries` (`skills-evolve.js:206-216`):

```206:216:plugins/dsh-agos/lib/skills-evolve.js
    if (wanted.has(entry.name)) {
      next.push(entry)
      continue
    }
    const origin = catalogEntryOrigin(entry)
    if (origin === 'project') {
      next.push(entry)
      continue
    }
    const confirmedGlobal = origin === 'global' || candidateNames.has(entry.name)
    if (!confirmedGlobal) next.push(entry)
```

Unlabeled live row → `origin === 'unknown'`. `candidateNames.has('deploy') === true` → `confirmedGlobal` → **dropped**.

Distinct-name project skill with `source: 'project-dsh'`, or unknown name **not** in candidates, is kept. That is the author's fixture, not the shadowing case this codebase already documents.

Comment at `skills-evolve.js:191-193` / `491-492` says rewrite keeps `shortlist ∪ project-scoped ∪ origin-unknown`. Code does **not** keep origin-unknown when the name is in the candidate set. Comment is false.

Existing tests (`skills-evolve.test.mjs:144-186`, `188-223`) use `inbox-triage` vs `repo-deploy` / `mystery-skill`. No same-name pair. **Test restates the author, not the original failure** (runtime global+project, candidates user-root only, project disappears — including same-name overlay).

### 2. Empty / throw / unknown catalogOf — **通过（空与非数组）；throw 有路径无专测**

- `[]` → `bindCatalogTrim` returns original decision (`skills-evolve.js:536-538`); tested `skills-evolve.test.mjs:215-217`.
- Non-array `{ catalog: ... }` → same (`532-534`); tested `219-222`.
- `trimRuntimeCatalogEntries` empty/undefined candidates → `{ ok: false }` → `rewriteCatalogDecision` leaves decision (`199-200`, `257`).
- `catalogOf` throw: handler `try/catch` returns `decision` (`524-558`). No test fires a throwing `catalog`. Residual, not the fail reason.
- Default `catalogOf = async () => []` (`502`) now fail-closed via the empty check.

Live catalog is left in these paths. Pass.

### 3. Stale progress/skills vs「无待处理」— **通过**

Wiring:

```208:211:frontend/src/pages/console-live.tsx
    progress: t.progress !== undefined ? (extra.progressStale ? 'stale' : 'ready') : 'absent',
    ...
    skills: skillsGroup ? (extra.skillsStale ? 'stale' : 'ready') : 'absent',
```

```294:297:frontend/src/pages/console-live.tsx
    progressStale: progressEnabled && progress.status === 'degraded' && progress.data !== undefined,
    skillsStale: overviewEnabled && overview.status === 'degraded'
      && overviewData !== undefined
      && typeof overviewData['skills'] === 'object' && overviewData['skills'] !== null,
```

`AttentionInbox` only prints「无待处理」when **both** absent and stale are empty:

```39:47:frontend/src/components/console/AttentionInbox.tsx
export function inboxEmptyText(sources: InboxSourceState): string {
  const absent = ALL_SOURCES.filter((k) => sources[k] === 'absent');
  const stale = ALL_SOURCES.filter((k) => sources[k] === 'stale');
  if (absent.length === 0 && stale.length === 0) return '无待处理';
  ...
  return `已采集的来源里无待处理;${bits.join(';')}`;
}
```

Badge: empty + not all ready → `queued`, not `done` (`AttentionInbox.tsx:51-54`).

Phase 1 trigger (last-good empty inbox + progress/overview `degraded`) now yields `stale` and cannot say「无待处理」. Tests lock both the partial-absent and all-present cases (`console-live.test.ts:248-271`), including `inboxEmptyText` / `inboxBadgeState`. This is the original inbox failure, not a restatement.

### 4. Pin vs extract rules — **通过**

Diff in `session-memory.mjs`: extract `whitespaceNormalized` from `normalizedText`; pin uses `whitespaceNormalized` then **rejects** `length > 200` instead of `unicodeSlice` then accept.

`extractSessionMemory` still goes `normalizedText` → `unicodeSlice(whitespaceNormalized)` → `classifyUserText` (`session-memory.mjs:46-47`, `238-240`). `classifyUserText` / `QUESTION_RE` / `TURN_ONLY_RE` / source gate unchanged. Pin comment at 156 matches the diff. Test `skills-evolve.test.mjs:225-234` is the original 201-codepoint silent chop. Must-not: extract rules. Held.

### 5. Tests that only restate the author

| Test | Verdict |
|---|---|
| `runtime trim keeps project and origin-unknown…` | **Restate.** Labeled distinct names. Misses unlabeled same-name overlay and host `SkillEntry` shape. |
| `trim hook keeps project skills when candidate audit is user-root-only` | **Restate** on keep-set; empty/non-array branches are real. |
| empty / non-array catalogOf | Real fail-closed. |
| pin 201 reject | Real original pin failure. |
| `deriveConsole` progress/skills stale → no「无待处理」 | Real original inbox failure. |

### index.js catalogOf

**Do not change.** `defaultSkillRootDefs` is user-root on purpose (`skills-console.js:19`). Adding project names to `candidateNames` would make `candidateNames.has(entry.name)` true for those names and **widen** the drop in `skills-evolve.js:215`. Ranking completeness is not required to keep project rows — and is unsafe until `confirmedGlobal` stops using name-in-candidates as an origin proxy.

### Phase 2 H 结论

| 项 | 结论 |
|---|---|
| catalog trim / same-name overlay | **打回** |
| catalogOf empty/throw/unknown | 空与未知 **通过**；throw 路径在、无专测 |
| console-live stale → 禁止「无待处理」 | **通过** |
| pin 不改 extract | **通过** |
| **H 整体** | **打回** |

H 不能过：must-keep「runtime 上的 project skill 裁完还在」对同名、无 origin 的宿主目录行仍不成立。console-live / pin 可留，不要为了过门把 `index.js` catalogOf 扩成项目根。

---

## Recheck H — same-name unlabeled（2026-09-08 18:58 Asia/Shanghai）

Read current `trimRuntimeCatalogEntries` and `unlabeled runtime name that also appears in the user-root audit is kept`. Did not re-litigate console-live / pin.

`confirmedGlobal` / `candidateNames.has(entry.name)` as a drop predicate is gone. Keep rule is now: shortlist, else keep unless `catalogEntryOrigin(entry) === 'global'` (`skills-evolve.js:206-214`). `candidateNamesOf` is only an emptiness/format gate (`198-200`), not an origin proxy.

Original trigger (unlabeled `{name:'deploy'}` + user-dsh candidate `deploy` + shortlist `inbox-triage`) is closed: unknown ≠ global → kept. The new test also keeps the labeled `project-dsh` twin (`skills-evolve.test.mjs:188-203`). Single-row host `{name,description}` winner follows the same branch.

**H 复核：通过。** 同名无标行不再因候选审计里有这个名字被裁掉。

---

## Phase 2 — E / G helpers（2026-09-08 18:59 Asia/Shanghai）

H not reopened. Helpers only. `live.ts` / `ChatPage.tsx` / `chat-transcript.tsx` still unwired — production path below is the old store/page, except `ApprovalPanel` itself already imports the helper.

### E helper — 通过；产品 尚早(未接线)

**status 省略还会不会「已放行」？不会。** 未传 `status` 时 `phase = localPhase`，点击只走 `localPhaseAfterClick` → `pending`（`ApprovalPanel.tsx:53-68`，`approval-state.ts:154-160`）。「已放行」胶囊要 `phase === 'resolved' && decision !== undefined`（`ApprovalPanel.tsx:71-83`）。`displayCopyForView` 只在 `resolved` + `allowed-once` 才出那句（`approval-state.ts:141-144`）。accepted / pending / 无 decision 的 resolved 都不是「已放行」。`approval-state.test.ts:42-59`, `212-218`；`ApprovalPanel.test.ts:30-52`。

Reducer：POST 失败/超时 `retainMapping` 仍为 true（`approval-state.ts:224-239`）；resolved 才删 map。协议仍是 `allowed-once | rejected`。

**未接线：** `chat-transcript.tsx:640-653` 不传 `status`/`decision`，仍 `void respondApproval`。`live.ts:283-293` 仍发送即删 map。面板已不会抢报已放行，但失败/重试/宿主 `approval/decided` 没有接进 store。省略 status 的点击会停在 pending 并锁按钮，直到接线。

### G helper — 通过；产品 尚早(未接线)

**page 失败会不会把当前窗当全史？不会。** `applyPageFailure` 强制 `historyIncomplete: true`、`retryable: true`，不把 `hasMore` 改成 false，不 rebuild（`session-history.ts:258-270`）。opening `hasMore` → `historyIncomplete`（`166`）。`HistoryIntegrity` 在 incomplete/retryable 时写「当前窗口不是完整会话」（`HistoryIntegrity.tsx:21-42`）。测试：`session-history.test.ts:131-151`。

**mux online 会不会挡住 follow 失败？helper 里不会。** `deriveConnectionSurface`：handshake ready 之后，`follow.failed || follow.phase === 'error'` → `follow-unavailable`（`connection-health.ts:135-144`）。`connectionHealthFromLive({ muxPhase:'online', followPhase:'error' })` 同结果（`connection-health.test.ts:14-27`, `62-73`）。

**未接线：** `live.ts:153-167` 仍丢 `header/hasMore/projections`，无 `session/page`。`conversation.phase === 'error'` 仍从未赋过。`ChatPage.tsx:886-887` 仍用全局 `streamOnline` 画「已连接」。helper 的 follow 轴接上去之前，产品行为与 Phase 1 相同。接线时不要只用 `followFromConversationPhase(id, 'live')` 包一层 — live store 现在不会报 follow error。

### 结论

| ID | helper | 产品 |
|---|---|---|
| **E** | **通过** | **尚早(未接线)** |
| **G** | **通过** | **尚早(未接线)** |
| **H** | 复核通过（不重开） | — |
