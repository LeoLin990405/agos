# 独立审查 — 主控自己的生产接线与修复

审查者：独立审查者（第三名），只读。工作树 `/Users/<name>/Projects/agos-round2-20260908`，分支 `cursor/agos-round2-20260908`，基线 `7e7e359`。未运行任何 git 写命令，未修改除本文件以外的任何文件，全部实验在 `/tmp` 做。未改 `HOME`/`CODEX_HOME`，未 `npm install`，未发起模型调用，未动 39411 上的宿主。

范围就是任务书划定的六节：主控自己写的四处台账事务接线、由主控新写的测试、`cn-capabilities` 计划文件名修复、主控对 F 遗留文件的修复，以及三份文档的诚实度。

> **审查期间工作树被并发修改，本报告的快照口径。** 我在 00:14 读了 `plugins/dsh-agos-router/lib/index.js`（当时四处接线用的是 `withLedgerLock` 的 30s 默认超时），00:21 该文件被改成统一传 `HTTP_LOCK = { timeoutMs: 5_000 }`，并新增了 `test/index-lock-timeout.test.mjs`（00:20）。**本报告的全部结论已按 00:21 之后的版本重核**，行号也按当前版本。这次并发修改把我原本的头号阻塞项降级了，理由与残留问题写在 A1。

## 结论摘要

接线本身是对的：四个点都在正确的位置，抛出路径会释放锁，重入既不自锁也不泄漏深度，C 关于「不圈住 `dispatchTeam`/`assembleLive`」的理由经核算成立。

**一条阻塞项：C1（P1）** —— 计划文件名的缺陷有**四**处，只修了三处。`plugins/cn-capabilities/lib/index.js:1993` 仍是 `PLAN_DIR + '/plan-' + Date.now() + '.json'`，而且它在「已批准、要执行」那条路径上，是四处里后果最重的一处。

**两条 P2 都在 E 节，都是「文档/注释说得比代码做到的强」，其中一条我实测证伪**：哨位机制并不能阻止「整文件豁免」，而 `REVIEW.md:240` 明写它能；`ret-08` 进 `KNOWN_GAPS` 的决定对，但写下的理由是事实错误（我实测 store 是空的，不是「还有别的条目」）。

其余为 P3。B 节新加的两个测试文件我逐条验过区分力，**都是真测试，不是摆设**；主控自己中途踩到并记下的那个「计时其实量到的是 `appendLine` 的锁」的假阳性，当前版本没有更隐蔽的变体。

---

## A. `plugins/dsh-agos-router/lib/index.js` — 台账事务接线

### 先回答任务书的五个问题

**抛出路径会不会漏放锁 —— 会释放，C 的说法成立。** `lib/ledger-lock.js:268-275` 的 `withLedgerLock` 是 `try { return fn() } finally { releaseLedgerLock(held) }`，`shadowLink`（`index.js:277-281`）与 `recordOutcome`（`index.js:351-355`）从回调里 `throw` 都走 `finally`。

**重入安全、深度计数不会泄漏 —— 两条都成立，我逐路径查过。** `acquireLedgerLock`（`ledger-lock.js:205-209`）里 `existing.depth += 1` 与 `return` 之间没有任何可抛出的语句；首次取锁的 `heldLocks.set(...)`（`:219`）排在 `tryPublish` 之后，`tryPublish` 抛出时状态尚未写入。因此**不存在**「加一之后抛异常、进程永久自认持锁」的窗口 —— 这正是任务书点名要查的那个泄漏形状。释放侧（`:242-248`）先减再判 `>0`；重入句柄没有 `fd`，也不会误 unlink 别人的锁。

**C 不圈住 `dispatchTeam` 的理由 —— 数字核对无误。** `lib/dispatch.js:33` `DISPATCH_TIMEOUT_MS = 45000`，三条角色流串行即 135s；`lib/ledger-lock.js:42` `DEFAULT_LOCK_TIMEOUT_MS = 30_000`。持锁 135s 不会被别人偷走（`isStale` 对「活 pid + startTime 相符」永远返回 false，`:133-147`），所以后果正是 C 写的「其他写者全部失败」。补一条 C 没说但同向的理由：`withLedgerLock` 是同步的，圈住 `async` 的 `dispatchTeam` 根本不成立 —— `finally` 会在 promise 创建那一刻就放锁。`transact` 收到的是同步回调（`dispatch.js:371`），所以现状正确。

**`backfillShadow` 的 `try/catch` 会不会把锁超时吞掉 —— 会，而且 5s 预算让它比原来更容易发生。** 见 A2。

**两条故意不圈的路径有没有独有风险 —— `assembleLive` 不双计、末位提案生效，C 说的都对。** `lib/assemble.js:217-240` 读行、算后验、追加 `kind:'assemble'` 行；`lib/ledger.js:98-101` 的 `foldLedger` 对 assemble 行只保留最后一条，且 assemble 行永不进 `decisions`，因此 `allocationStateFromLedger`（`assemble.js:58-82`，只认 `outcome` 为 `ok`/`fail` 的决策行）不可能把它计入后验。**不双计，末位提案生效**，与 C 的陈述逐字一致。它确实有一条独有风险，但方向不在事务上，见 A4。

### A1（P3；原为 P2，已被主控在审查期间大幅收窄）读路径被接成无条件取跨进程同步锁

**位置** `plugins/dsh-agos-router/lib/index.js:291`（`backfillShadow` 的包裹），经 `:310` 由 `listRoutes` 在每次 `GET /api/agos/routes` 上调用；预算定义在 `:249-261`。

**接线改变了什么。** 接线前 `backfillShadow` 在 `links.size === 0` 时**先返回、一次锁都不取**，取锁只发生在真有 pending 行要写的 `appendLine` 里。接线后取锁被提到最外层，于是「没有任何影子链接」这个常见情形也要取一次锁。读路径从「只在写时取锁」变成了「每次读都取锁」。

**为什么这在这套代码里格外要紧（实测）。** 等锁走 `Atomics.wait`（`ledger-lock.js:60-64`），在 Node 主线程上是真同步阻塞。我在 `/tmp` 里用同一份锁代码量化过（只用临时台账文件）：

```
blocked for 810ms; 10ms timer fired 0x during it (a free event loop would fire ~81x)
```

810ms 里 10ms 定时器触发 **0** 次 —— 期间宿主进程的其他 HTTP 请求、SSE 流、心跳、别的插件的定时器全部停摆。被 park 的不是「这一个请求」，是整个单线程宿主。

**主控已在审查期间自行发现并收窄。** `:249-261` 新增的 `HTTP_LOCK = { timeoutMs: 5_000 }` 传给了全部四处（`:284`、`:300`、`:359`、`:406`），把最坏冻结从 30s 压到 5s，注释里对机制的定性与我实测到的一致，并且明确写了「这道风险是接线放大的」。这一处理是对的，因此我把它从 P2 降为 P3。

**残留的、我仍建议改的一点（非阻塞）：读路径的预算可以远小于写路径，理由不对称。**

- 写路径（`shadowLink`/`recordOutcome`/`transact`）**必须**等到锁 —— 等不到就是一次用户可见的拒绝，5s 的容忍度合理。
- 读路径的回填是**幂等**的：跳过这一轮，下一次 `GET /routes` 会重算同一份 pending 集合。放弃它的代价是「这次列表少几行回填」，而列表本来就把未回填的行诚实显示为 pending。

也就是说，读路径花 5s 冻住整个宿主去换「这一次就把回填做掉」，换来的东西下一次轮询就能免费拿到。控制台在轮询 `GET /routes`，一个持续持锁的对端会让宿主每轮冻 5s。

**最小修法：** 给回填单独一个短预算，其余三处保留 5s。

```js
const HTTP_LOCK = { timeoutMs: 5_000 }
// 回填是幂等的:取不到锁就跳过,下一次 GET 会重算同一份 pending。读路径不值得为它 park 住整个 host。
const BACKFILL_LOCK = { timeoutMs: 250 }
```

### A2（P3）锁超时被折叠进「回填失败(不影响列表)」，而调用方连返回值都丢掉

**位置** `plugins/dsh-agos-router/lib/index.js:301-305`（catch），`:310`（`backfillShadow(cfg)` 的返回值未被接收）。

`LedgerLockError`（`code: 'AGOS_LEDGER_LOCK_TIMEOUT'`）会被这个 catch 接住，打一条 `logger.warn('影子回填失败(不影响列表)')` 然后 `return 0`。「锁超时」与「没什么可回填」在返回值上不可区分（都是 0），不过这一点其实无关紧要，因为 `listRoutes:310` **压根没接这个返回值**；两者真正的区别只剩「有没有那条 warn」。

**可以接受的部分：** 列表本身依然诚实 —— 没回填的行照旧显示为 pending，没有编造任何终态。**不可接受的部分：** 一次数秒的宿主冻结加一次回填缺失，对外只表现为一条说「不影响列表」的 warn，文案把最重的后果说成无关紧要。5s 预算落地之后这件事更值得修，不是更不值得：30s 的超时在实践中几乎不会发生，5s 会。

**最小正确修法：** 在 catch 里按 code 分流文案。

```js
} catch (err) {
  const timedOut = err && err.code === 'AGOS_LEDGER_LOCK_TIMEOUT'
  logger.warn(timedOut ? '影子回填本次跳过:台账锁被其他写者持有' : '影子回填失败(不影响列表)', …)
  return 0
}
```

### A3（P3，潜在，非当前缺陷）`transact` 是注入点，而 `withLedgerLock` 只对同步回调成立

**位置** `plugins/dsh-agos-router/lib/index.js:406`（注入），契约实现在 `lib/ledger-lock.js:268-275`（C 的文件）。

`withLedgerLock` 同步取锁、同步 `finally` 放锁。今天四个调用点的回调都是同步的（`dispatch.js:371` 的 `transact(() => {…})` 也是），所以现在没有 bug。但 `transact` 是一个**依赖注入点**，它对调用方承诺的是「在锁内跑这个」；哪天有人传进一个 `async` 回调，锁会在 promise 创建的瞬间释放，临界区静默失效，现有测试一条都不会红。

**最小正确修法**（在 `ledger-lock.js`，属 C 的文件）：`withLedgerLock` 对 thenable 返回值直接抛错，把「只能同步」从注释变成可执行约束。

### A4（P3，不是接线造成的，一行记录）

`assembleLive` 不圈锁没有双计问题（已核实），但 `foldLedger` 只保留最后一条 assemble 行，意味着两个并发提案里只有后落的那条会成为 `listed.assemble`。`dispatchLiveRequest` 在 `body.ref` 为空时不做 `ASSEMBLE_MISMATCH` 校验（`lib/dispatch.js:246-250`），此时会对着别人的提案试跑。这是既存的单槽语义问题，**加锁也修不了**，只是任务书问到「两条未圈路径是否有独有风险」时应当如实说一句：有，但方向不在事务上。

---

## B. 主控新写的两个接线测试

先说好的部分，因为它们解决的是真问题：接线之前**没有任何测试**能抓到漏接线（`REVIEW.md:107` 的实测：换成直通仍 116/116）。两个文件把三个接线点和超时预算都变成了运行时可证伪的。当前六条我连跑三次全绿，耗时稳定：阻塞组 569–622ms、超时上界 5125ms、负控 26–29ms。

### B.1 `test/index-transaction.test.mjs` — 先回答任务书的四个问题

**`waited >= 300ms` 对着 500ms 持锁会不会抖 —— 不会。** 被阻塞的调用耗时**下界**就是持锁时长（子进程 `setTimeout(HOLD_MS)` 之后才释放），机器再忙只会让 `waited` 更大，而断言是 `>=`。实测 569–622ms，离 300ms 有近一倍余量。反方向（负控 26–29ms 要小于 300ms）需要 11 倍降速才会翻车，可以接受。

**`recordOutcome` 那条断言是否真的对接线敏感 —— 是，我逐路径验过，没有更隐蔽的变体缺陷。** 去掉接线：读在锁外、先于并发写者落盘，看不到 `ok`，于是 `appendLine` 在 500ms 后追加 `fail`，台账里出现两条互相矛盾的 outcome → `outcomes.length === 1` 失败。接线在：读在锁内、必然看到 `ok`、`bindOrdinaryOutcome` 回 `CONFLICTING_RESULT`（我用真实 rows 直接调过，确认返回 `ok:false, code:'CONFLICTING_RESULT'`）。**这一条的判据完全不看时间**，所以主控踩过的那个「计时量到的其实是 `appendLine` 的锁」的坑在这里不成立。

**子进程会不会泄漏 —— 不会。** 三条测试里 `await holder.done` 都排在所有断言**之前**（`:150`、`:181`、`:198`），而且子进程无论如何都会在 `HOLD_MS` 后自行释放并 `exit(0)`。子进程若拿不到锁则非零退出，`ready` promise 会 reject 并给出「本次判定无效」的明确信息，不会静默变成假绿。

**最后一条负控证不证明它声称的东西 —— 一半，见 B2。**

### B2（P3）第四条测试的标题与注释把它说成重入负控，但文件里没有一条测试走到深度 ≥ 2

**位置** `test/index-transaction.test.mjs:209`（标题「重入不自锁 —— 锁按深度可重入」）、`:214-216`（注释「GET /routes 的链路是 listRoutes → backfillShadow,两层都在同一进程内取同一把锁」）。

注释的事实描述是错的：`listRoutes`（`lib/index.js:308-331`）自己**不取锁**，全路径只有 `backfillShadow` 取一次。而且我实测过：该测试 seed 的台账只有一条决策行、没有 `shadow-link` 行，`validatedShadowLinks(seeded, new Map()).size === 0`，于是 `backfillShadow` 在 `appendLine` 之前就 return 了 —— 深度始终是 1。同理 `recordOutcome` 那条走的是 `CONFLICTING_RESULT` 抛出路径，也没有 `appendLine`。**四条测试没有一条进入重入分支。**

要说清这**不是覆盖空洞**：重入在 C 的 `test/ledger-multiprocess.test.mjs:149-157` 里被真实覆盖（`withLedgerLock(path, () => { … appendLine(path, …) })`，`appendLine` 会再取一次同一把锁），深度计数坏了那边会红。所以这里是**标题与注释误述**，不是缺测试。

**最小正确修法：** 把标题与注释改成它实际证明的东西 —— 「无人持锁时端点立刻返回（证明上面三条的等待来自外部持锁，而不是端点本身慢）」，并把重入的证据指向 `ledger-multiprocess.test.mjs`。

### B3（P3）注释声称守住了「catch 不把锁等待吞成静默失败」，这条测试不可能守住它

**位置** `test/index-transaction.test.mjs:200-201`：「backfillShadow 自带 try/catch 且失败不影响列表 …… 这一条同时守住了那个 catch 不会把锁等待吞成静默失败。」

该测试持锁 500ms，预算 5s（当时是 30s），**根本不会超时**，catch 一次都没进过。它证明的是「等到锁之后列表照常 200」，不是「超时不会被吞」。

**最小正确修法：** 删掉后半句。真要覆盖它，现在已经容易了 —— `index-lock-timeout.test.mjs` 已经有一个「持锁久于预算」的夹具，照它的形状对 `GET /routes` 再加一条，断言列表仍 200 且 warn 里出现锁超时文案（配 A2 的分流文案）。

### B4（P3）第二、三条的区分力靠「seed 的台账不会触发 appendLine」，而这一点没有被钉住

`shadowLink` 那条能区分接线，是因为 `batchId: 'batch-does-not-exist'` 在 `appendLine` 之前就被拒；`GET /routes` 那条能区分，是因为 `links.size === 0` 时根本没有 `appendLine`。两者都是**载荷选择**带来的性质：一旦有人为了「更真实」给 `seedLedger()` 补上 shadow-link 行，测试就会静默退回去量 `appendLine` 自己的锁 —— 正是主控在 `recordOutcome` 上已经踩过一次的那个坑（`REVIEW.md:112`）。

**最小正确修法：** 这两条各加一句断言，钉住调用前后台账行数不变（即这次调用没有走 `appendLine`），把「为什么它有区分力」写成可执行的。

### B5 `test/index-lock-timeout.test.mjs`（审查期间新增）—— 这个文件没问题

两侧都钉了，而且互为负控，这是对的做法：上界（持锁 35s，断言 `elapsed < 17.5s`、状态非 200、**且台账里没有 outcome 行**）挡住「退回 30s 默认值」，下界（持锁 500ms，断言 200 且落盘 1 行）挡住「把 `timeoutMs` 改成 1 让上界变快」。删掉任一条另一条都能被绕过，文件头 `:8-11` 也把这层关系写明了。`finally { await holder.kill() }` 保证断言抛出也不留子进程。我实测两条都过（5125ms / 580ms）。

一处非阻塞观察：`CEILING_MS` 取 5s 与 30s 的中点（17.5s），所以这对测试实际锁定的是「预算落在约 0.5s–17.5s 之间」，把 `HTTP_LOCK` 调成 15s 两条都还会绿。`:28-29` 的注释已经把这个取法讲清了，属可接受的取舍，不是缺陷。

---

## C. `plugins/cn-capabilities/lib/index.js` — 计划文件名

### C1（P1，阻塞）缺陷有四处，只修了三处；漏掉的那处在「已批准、要执行」路径上

**位置** `plugins/cn-capabilities/lib/index.js:1993`：

```js
planFile = PLAN_DIR + '/plan-' + Date.now() + '.json'
```

紧接着就是 `writePlanObject(planFile, …, { create: true })`（`:1995`），即与被修的三处（`:1935`、`:1960`、`:2253`）**完全同一个 fail-closed EEXIST 闸**。`REVIEW.md:136` 与 `lib/index.js:375-383` 的注释都写「三处生成点统一走新的 `planFileName()`」，实际是四处中的三处。

**为什么这一处比另外三处更要紧。** 它所在的分支是 `plan_run` 带 `approve=true`、通过批准门、既没有 `planFile` 也没有 `findMatchingPlanFile` 命中时的落盘 —— 也就是**人已经批准、马上要执行**的那一步。同毫秒撞名时它返回 `'❌ 计划落盘失败，未执行:' + …`，一次已获批准的执行被时钟精度挡掉。另外三处里有两处是「出计划、等人看」，重试代价低得多。

**最小正确修法：** 这一行也换成 `planFileName()`。一处替换，无其他改动。

### 其余问题的回答（都没有问题）

**6 位十进制够不够 —— 够，而且这条路径的并发率远低于 `asm-`/`dsp-`。** 计划创建由人在计划模式里点、或由 `plan_run` 工具调用触发，量级是每天几十次、极端情况同一毫秒两次；同毫秒双抽撞同一尾数的概率是 1e-6。`PLAN_NAME = /^plan-\d+\.json$/`（`lib/plan-path.mjs:17`）对位数**无上限**，所以这里其实还有免费的熵可拿（不像 `asm-`/`dsp-` 被前端 20 位卡死），注释也如实写了「位数不限」。选 6 位是保守但充分的。

**新名字有没有破坏消费者 —— 任务书点名的四类我全查了，都不破坏。**

| 消费者 | 位置 | 结论 |
|---|---|---|
| `PLAN_NAME` / `resolvePlanPath` | `lib/plan-path.mjs:17`、`:41-58` | 纯数字尾，通过 |
| `GET /api/cn/plans` | `lib/index.js:434` | `PLAN_NAME.test` 过滤 + `.sort().reverse()`；名字总宽固定 19 位（13 时间戳 + 6 尾），字典序仍等于时间序 |
| `planFile` 工具参数 | `lib/index.js:1903-1906` | 走 `resolvePlanPath`，通过 |
| 前端计划面板 | `frontend/src/components/console/plans-model.ts:74` | 按 `name.localeCompare` 倒排，同上，仍是时间序 |
| router 的结果行 | `plugins/dsh-agos-router/lib/outcomes.js:224`、`:107-119` | 正则同样是 `\d+`；`derivePlanRows` 的时间取 `plan.executedAt` 字段，**不从文件名解析** |

**「从文件名反解时间戳」的真风险 —— 全仓没有这种消费者。** 我按 `slice(5`/`substring(5`/`Number(name`/`replace(/plan-` 全仓搜过，一个都没有。所以任务书担心的 `Number(name.slice(5,-5))` 拿到错时间（会得到 ~1.79e18ms）今天不会发生。

**`randomInt` 的导入与同步用法 —— 都正确。** `import { randomInt, randomUUID } from 'node:crypto'`（`:4`）。`randomInt(0, 1_000_000)` 无回调即同步，返回 `[0, 1000000)`，`padStart(6,'0')` 恒为 6 位。它走 CSPRNG 的缓存熵池，微秒级，而这条路径本来就在做异步磁盘 IO，开销可忽略。

**其他 `Date.now()`-as-identity —— 除上面那一处外，`plugins/*/lib/index.js` 里没有别的同类缺陷。** `plugins/dsh-agos/lib/index.js:387` 与 `:433` 用 `agos-running-${Date.now().toString(36)}` / `agos-attached-…` 做 `rpcId`，我看过用法：每次都是单发 unary POST 并读自己那次响应的 body，重复 rpcId 不会串响应，不构成缺陷。其余命中都是 `ms: Date.now() - t0` 这类耗时计算。

### C2（P3，措辞）没有分隔符，文件名不再是可解析的时间戳，而定义处没写这句

`plan-${Date.now()}${tail}` 把两个字段并进同一段数字。这是被 `PLAN_NAME` 逼出来的（正则不允许第二个连字符），做法正确；但 `:375-383` 那段注释解释了「为什么必须纯数字」，**没有**说「因此这个名字不再能当时间戳解析」。今天没有消费者这么做，将来有人这么做时会拿到一个纪元后 5000 万年的时间，且不会报错。

**最小正确修法：** 在既有注释里加一句 —— 尾数与时间戳之间无分隔符，任何取时间的地方必须读文件内容里的时间字段，不得解析文件名。

---

## D. `plugins/cn-capabilities/test/plan-filename-collision.test.mjs`

五条测试成立，其中「回退成纯 `Date.now()` 会被位数断言确定性抓到」这一点我认可 —— 它不靠碰撞概率。

**`Date.now` 的恢复是完整的。** `:69-81` 在 `finally` 里 `Date.now = realNow` 复原自有属性；被打补丁的窗口内**没有任何 `await`**（`await import('node:crypto')` 排在打补丁之前），node:test 的顶层测试又是顺序执行的，所以不会与同进程其他测试交错。这一条没问题。

**最后一条确实驱动生产代码，没有误测本地副本。** `:148` 的 `created` 来自 `readdirSync(PLAN_DIR)`，落盘的名字是生产 `planFileName()` 生成的；`:151-156` 对磁盘上的名字断言数字位数 > 13。`fakeSubagents`/`fakeCtx` 只负责把 `plan_run` 注册出来并让计划者返回一份合法 JSON，之后走的是真实 `writePlanObject` → 真实 `openPlanFile('wx')` → 真实磁盘，**够格证明生产行为**。

### D1（P3，措辞）注释声称本地副本能守住与生产的一致，实际守不住

**位置** `test/plan-filename-collision.test.mjs:63-64`：「与 lib/index.js 的 planFileName() 同一份实现。两处对不上时本文件第一条会红。」

第一条测试用的是本地副本 `planFileName(randomInt)`，生产实现改了它也照样绿。真正与生产对齐的只有最后一条。

**最小正确修法：** 那句注释改成「本地副本只用于考察随机尾的量级；与生产的一致性由最后一条测试（读磁盘上的真实文件名）保证」。

### D2（非阻塞，属偏好）

- 480 这个下限偏松。500 抽 1e6 的生日问题：期望碰撞对 ≈0.125，`P(≥1)≈12%`、`P(≥2)≈0.7%`、`P(≥3)≈0.03%`。所以 498 既紧又几乎不抖；480 相当于只断言「尾巴存在」，退化到 4 位随机尾（期望 ≈488 个不同）会卡在下限附近抖动。主控的 12% 计算本身是对的，选 480 是保守，不是错。
- `:148` 的 `listPlans().slice(before)` 用「个数」当排序数组的偏移，只在新名字字典序排在旧名字之后时成立 —— 今天成立（前一条测试造的 `plan-1788000000000000001.json` 第 5 位是 `0`，实时名字是 `8`）。用集合差更稳。

---

## E. `plugins/dsh-agos/test/session-memory-zh-eval.test.mjs` — 对 F 遗留文件的修复

**行号前缀清理是干净的：** 全文件 `^\s*[0-9]+\|` 命中 0，三份 fixtures 与 README 也是 0，实跑 9/9、exit 0。

### E1（P2）哨位剜除挡不住「整文件豁免」，而文档明写它挡得住

**位置** `test/session-memory-zh-eval.test.mjs:388-396`（`withoutPatternTable`，尤其 `:393` 的断言），`REVIEW.md:240`。

`REVIEW.md:240` 写：「**没有选择把整个文件豁免** …… 哨位缺失或次序颠倒时直接 assert 失败，**不允许静默降级成整文件豁免**。」

`:393` 的守卫只有 `assert.ok(from !== -1 && to > from)` —— 它验证哨位**存在且有序**，不验证被剜掉的区段有多大。把 `begin` 移到文件头、`end` 移到文件尾，断言照样通过，全文件被剜掉，自检彻底空转。我在 `/tmp` 上用同一份剜除逻辑跑了四种情形：

```
as-shipped                                   : excised   791 bytes -> NO HITS
personal path hidden INSIDE sentinel region  : excised   837 bytes -> NO HITS
personal path OUTSIDE sentinel region        : excised   791 bytes -> CAUGHT 个人 home 路径, 会话归档目录
sentinels widened to wrap the entire file    : excised 16727 bytes -> NO HITS（断言未触发）
```

第二行是设计上就接受的代价，而且**区段目前是紧的** —— 它只框住 `:373-385` 的 `forbidden` 表加三行说明（18 行），想藏路径必须写进规则表，diff 里显眼。**第四行才是缺陷**：文档承诺的那件事，代码没做到。主控的两条反证（区段**之外**注入、**删掉**起始哨位）都绕开了这个方向，所以没发现。

**最小正确修法**（紧贴现有断言加两行）：

```js
assert.ok(from !== -1 && to > from, '自检哨位注释缺失或次序颠倒,评测器自扫已失效')
assert.ok(to - from < 1200, '自检哨位区段被放大,等于整文件豁免')
assert.ok(text.slice(from, to).includes('const forbidden = ['), '哨位区段没有框住规则表')
```

改完之后 `REVIEW.md:240` 那句话就名实相符；不改代码就得改那句话。

### E2（P2）`ret-08` 进 `KNOWN_GAPS` 的**决定**是对的，但**理由是事实错误的**，且掩盖了一条真发现

**位置** `test/session-memory-zh-eval.test.mjs:88-96`（`why`，尤其 `:93`），同一句复制在 `REVIEW.md:234`。

原文：「`no-overlap` 恰恰是排序器此刻唯一诚实的说法：**store 里还有别的条目**，query「密码」与它们没有整段重合，落回重要度并自报「没有重合」正是本包要求的行为。」

**store 里没有别的条目 —— 一条都没有。** fixture 的 `ret-08` 只有一个 item（`secret-item`），它在 pin 时就被 `SENSITIVE` 拒了。我直接调生产代码测过：

```
ret-08 items in fixture: 1
refused pins: [["secret-item","SENSITIVE"]]
store size AFTER pinning: 0
proposal.fallback = "no-overlap"   (fixture expects null)
proposal.items.length = 0
proposal.note = "词面没有重合，按重要度回注"
```

**决定本身站得住：** 该文件第 3 条纪律禁止改 fixtures 的 `expect`，而 `fallback: null` 表示「存在词面命中」，空 store 下任何诚实实现都给不出 `null`，所以 fixture 确实写窄了，登记而不改 fixture 是合规的。两条要紧断言（pin 被拒、`recall` 为空、`notRecall` 命中）也确实都过 —— 这部分我核实无误，**不是把真回归重新贴标签**。

**但理由错了，而且错得有代价。** 真正的机制是「store 是空的」，不是「有别的条目但不重合」。照现在的 `why` 去修这条缺口的人会去找那些不存在的条目。更要紧的是，正确的机制指向一条主控没记下的真发现：**空 store 与「有条目但都不匹配」被报成同一个 `no-overlap`，而 `note` 说「按重要度回注」时其实一条都没回注**（`lib/session-memory-rank.js:209`、`:234`）—— 这在一个把「缺席只能表示未采集」写进契约的包里，是个该登记的口径问题。

**最小正确修法：** `:93` 与 `REVIEW.md:234` 的那半句改成事实（「store 为空 —— 唯一的候选在 pin 阶段就被拒了」），并在 `KNOWN_GAPS.retrieval` 里把「空 store 被报成 `no-overlap`、且 `note` 声称回注了而实际回注 0 条」作为一条独立缺口登记。不需要改产品代码。

### E3（P3）fixture 的 `pinRefused` 字段无人断言

`retrieval.jsonl` 的 `ret-08` 带 `pinRefused: ["secret-item"]`，评估器把实际被拒的 pin 收进 `report.refusedPins`（`:246`）却只在日志里打了个数（`:283`），从不与 fixture 的期望比对。这个字段是死数据，改成任何值都不会红。**最小修法：** 在 F2-3 里加一句 `assert.deepEqual` 比对两者。

---

## F. 文档诚实度

三份文档整体处在我读过的同类文档里偏诚实的一端：`VERIFICATION.md:22-37` 用三种依赖配置的实测对照把上一轮的数字「凭什么成立」摊开；`:33` 明写两项跳过「是跳过不是通过」；`:110` 明写「实跑 24 个测试全通过，但这 24 个里没有一个是 Linux 上的真实隔离证据」；`:143` 主动登记第四个接线点至今无覆盖；`:162` 主动声明 `frontend-test.txt` 做过路径脱敏并把声明写进日志文件本身。

**没有发现把静态检查或 fake 说成真宿主/真 OS 检查的地方** —— `:99-110` 那张 macOS-真子进程 / Linux-未动态验收的分界表逐项对得上。**也没有发现把上一轮数字当本轮结果用的地方** —— 833/0/3 在 `:131` 明确标为本轮重算，`logs/final/*.txt` 的六个计数与 `:122-129` 的表逐行吻合（我逐个对过）。

### I4 的推导 —— 我独立核实，**结论成立**，而且文档的定性标注是对的

链条我逐环读过：

1. `host.describe` 在宿主上确实不存在。主控引用的是「对 `plugins/node_modules/@deepseek-ai/` 跑 `rg` 命中 0」；我另外对 `~/.dsh/profiles/headless/node_modules/@deepseek-ai/`（**194 个包**，含该文档自己引用的 `dsh-app-boot` 等宿主包）复扫，同样 **0 命中**，`attachedSessions` 也 0 命中。更直接的独立证据：`frontend/UPSTREAM.pin:9` 自己就写着 `host.describe removed (home via $events ready)`，而前端**已经迁移完了**（`frontend/src/stores/live.ts:440`、`frontend/src/components/chat/NewSessionModal.tsx:38` 都标注为 host.describe 的替代）。全仓唯一仍在调它的就是 `plugins/dsh-agos/lib/index.js:428`。
2. `attachedFromRpc()`（`:425-450`）对 `!response.ok`、`result.ok !== true`、`typeof count !== 'number'`，以及 catch 分支**一律**返回 `{available:false, attached:false}`。方法不存在必然落进前两个之一。
3. `assertDetached()`（`:860-868`）先查 `available`，不可用直接抛 `503 LIVE_STATUS_UNAVAILABLE 暂时无法确认会话是否仍挂载，未执行删除`。
4. 生产接线 `:1427-1428` 传的是真实的 `runningFromContext`/`attachedFromContext`；`attachedFromContext`（`:452-461`）在 `ctx.sessions`/`ctx.get('sessions')` 缺席时落到第 2 步。

**结论确认：web profile 上 `assertDetached` 永远不可能成功，删除恒 503。** 顺带确认删除不会先被别的门挡住：`assertNotRunning`（`:850-858`）走的是 `session.list`，该方法在宿主上存在，所以用户看到的确实是 `LIVE_STATUS_UNAVAILABLE` 这一条。文案「暂时无法确认」把永久失效说成暂时故障，这个判断我同意。

`REVIEW.md:86` 的定性标注**正确**：「由「已核实的方法缺失」加「代码路径阅读」推导得出，**不是一次动态宿主验收**」，并如实交代了 39411 上两个探测都返回 `unauthorized`、没有绕过鉴权。这是本轮文档里写得最规矩的一段。

唯一可加强处（P3，措辞）：`REVIEW.md:70` 引用的 rg 范围是插件依赖子集（25 个包），而同一份文档 `:13-16` 引用的 `dsh-app-boot`/`dsh-home-paths` 并不在这个子集里 —— 那次扫描扫不到它自己引用的宿主包。结论没受影响（我用 194 包的树复扫，同样 0），但一条 P1 的证据句应当引用更全的那次扫描，或把范围写清。

### F1（P3）B 的场景 8 在三处文档里有三种状态

- `REVIEW.md:92`：「九个场景 8 通过 1 失败」，`:94-100` 整节按「失败」写。
- `HANDOFF.md:67`：「**真实宿主端到端：九个场景全部在真宿主上通过**」。
- `HANDOFF.md:92`：`- [ ] B 场景 8 夹具修复与重跑` —— 未打勾。

我查了产物：`frontend/tests/host-integration/artifacts/results.json`（`at: 2026-09-08T16:00:21.682Z`）是 `passed 9 / failed 0 / hostExit.code 0`，九条全 `status: pass`。**证据支持 `HANDOFF.md:67`**，所以 `REVIEW.md:92-100` 与 `HANDOFF.md:92` 那个复选框是过时的。这不是夸大 —— 其中一处比证据说得**弱** —— 但三份文档对同一件事给三种状态，读者无法判断哪个是终态。

**最小正确修法：** 在 `REVIEW.md` 的 I5 顶上加一行「B 已修夹具并重跑，`results.json`（2026-09-08T16:00:21Z）为 9/0；以下为原始故障记录」，并勾掉 `HANDOFF.md:92`。顺便说明 I5 里要求的「`blocked` 与 `fail` 分开报」是否已落实 —— 现在的 `results.json` 只有 `pass`，看不出来。

### F2（P3）抗抖动的「连跑五次全绿」不是在交付树上取得的

**位置** `VERIFICATION.md:167`：「修复后连跑五次 **5 × 108/0**，抖动消失。」

交付树的 `cn-capabilities` 是 **113** 个测试（`:126` 与 `logs/final/cn-capabilities.txt` 一致）—— 113 = 108 + 新增 `plan-filename-collision.test.mjs` 的 5 项。所以那五次连跑发生在新测试文件加入**之前**，「抖动消失」这个结论没有在交付树上被验证过。这正是同一句自己立的规矩：一次绿在有抖动的套件上不构成证据。

**最小正确修法：** 在交付树上再连跑五次（`5 × 113/0`）并替换该行，或注明这五次的测试数为 108、与交付树差一个测试文件。

---

## 我没有验证的事（免得本报告被读得比它证明的更强）

- **没有做任何动态宿主验收。** 没碰 39411，没启停 DSH，没做真实模型调用。I4 我是把主控的推导重走一遍并补强了证据，性质仍是推导。
- **没有在真实 DSH 宿主进程里验证 A1 的表观后果。** 事件循环冻结是我在独立 Node 进程里用同一套锁代码实测的（810ms 内 10ms 定时器 0 次），推到「控制台轮询会冻宿主」这一步依赖「路由处理器跑在宿主主事件循环上」这个前提 —— 该前提来自 `ctx.inject(['webServer'], …)` 的代码形状，我没有在真宿主上计时验证过。主控 `lib/index.js:249-260` 的注释独立得出了同一结论。
- **没有跑各包全套件。** 只跑了 `test/index-transaction.test.mjs`（三次）、`test/index-lock-timeout.test.mjs`（一次）与 `test/session-memory-zh-eval.test.mjs`（一次）；其余计数是核对 `logs/final/*.txt` 与 `VERIFICATION.md` 表格的一致性。
- **`ctx` 在 web profile 上是否真的不公开 `sessions` 服务**，我没有独立证实（这是 I4 链条里最弱的一环，也是主控引用的既有代码注释）。不过即便它公开了，`attachedFromRpc` 仍是一段调用已被删除方法的死代码。
- **B 与 D 两包本身不在我的范围内**，我只核对了三份文档对它们的陈述与 `results.json` 是否自洽。
- **工作树在我审查期间仍被并发修改**（`lib/index.js` 00:21、`test/index-lock-timeout.test.mjs` 00:20）。本报告的结论对应我最后一次核对的状态（`lib/index.js` md5 与 00:21 版本一致，六条接线测试实跑全绿）；如果在此之后又有改动，A 与 B 两节需要重核。
