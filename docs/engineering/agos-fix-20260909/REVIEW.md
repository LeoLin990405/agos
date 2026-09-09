# 评审记录（第三轮，2026-09-09）

给下一位审查者：本文件不复述「做了什么」（那在 [TASKS.md](TASKS.md)），
只写**判断依据**、**反对意见与如何被回应**、以及**我认为最该被质疑的地方**。

---

## 本轮真正的题目

Luna 的核查结论不是「有 13 个 bug」，而是一句更难受的话：
**主代码门 927 pass / 0 fail，独立 selftest 只有 1 pass / 13 fail——历史的「14/14」不能证明交付树。**

也就是说，上一轮的绿是「测了另一棵树」得来的。所以本轮的每一项修复，
判据都不是「现在绿了」，而是**「把它改坏，对应的检查会不会变红」**。
本文件里每条结论后面都挂着这个否证。

这个视角在验证阶段又抓出三个同型问题（[TASKS.md §9](TASKS.md)），它们不在任务书里——
说明这类毛病是系统性的，不是八个孤立缺陷。

---

## 零、先说一件对我不利的事：我宣布完成的一项，只修对了一半

任务书第 6 项（会话删除的真实宿主判据）我这样交的：查了固定宿主源码、确认
`host.describe` 已删、把 `session.list` 改成 `session/list`、写了 13 项测试、全绿，
然后在文档里写「已按固定宿主源码定案」。

**方法名对了，信封形状还是错的。** 发出去的 `payload` 是 `{}`，缺整个 `args` 层，
被固定宿主的 gateway 直接拒（`index.ts:950-953` 要求 payload 含恰好一个
plain-object `args` 字段）。所以 web profile 上的删除**照样永久 503**，
只是换了个失败理由。这是独立复核抓出来的，不是我自查发现的。

**为什么 13 项测试全绿**：它们的假 fetch 只被断言了 `url` 和 `method`，
请求体的其余部分根本没人看。我把测试对准了「方法名」这一个维度——
因为那是我当时**认定**的病根——于是它们对「信封形状」这一维毫无判别力。

这件事的教训不是「要更仔细」，而是具体的：**当我修的是「调用对方的方式错了」这类问题时，
替身式假对象天然会放过我，因为替身的宽容度由我自己写。** 现在那个假 fetch 被换成
逐字实现宿主两条谓词的**假 gateway**，并且配了一条元证明负控——把四种错形状喂给它，
断言它真的会拒。没有那条负控，「形状对了」这个断言本身就是无根据的。

我把这条放在最前面，因为它直接影响审查者该怎么读这份文档：
**下面每一处「我验过了」，都应当先问「你的替身有多宽容」。**
同型的另外两条（Fleet 预览把拒绝吞成空 200、裸 `--write-floors` 静默失效）
在 [VERIFICATION.md §8.5 / §8.6](VERIFICATION.md)。后者是我自己踩的：
验收器自己的工具让我以为下限已重算，实际一字未动。

---

## 一、最该被质疑的三处（我自己先列）

### 1. 依赖面预检的陈旧降级，是不是把一层检查悄悄关掉了？

**担心是对的，这正是我改第二版的原因。** 第一版按 `gitHead` 判陈旧——
但产物自己要被提交，一提交 HEAD 就变，于是它**永远陈旧**，
而陈旧时预检不再拦人 = 这层检查被永久关掉，比不加还糟。

现在按**内容指纹**判（`lib/surface-inputs.mjs`，覆盖各插件 `test/`+`lib/`、宿主树 `package.json`）。
`NC20f` 专钉这一点：`gitHead` 故意设成全 0，只要内容一致就必须判「新鲜」，
缺包照旧判失败。`NC20g` 管另一头：旧格式产物（没有指纹）一律按陈旧处理，
不许靠「缺字段」绕过判断。

**仍然可质疑**：陈旧时不硬失败，只降级为参考。理由是它可能只是没重测，
而**权威判定在 `host-modules-check`（完整静态导入图）那一闸，它在门里、它会硬失败**。
如果审查者认为「陈旧也该硬失败」，这是一个可以改的策略决定，
代价是每次改动 `plugins/**` 后不重测就过不了门。

### 2. 宿主集成豁免，会不会变成万能放行证？

三道锁，各有负控：
- 豁免只对**清单里逐条声明**的说明符生效（`NC20a`：没声明的缺了照旧失败）；
- 豁免必须**点名**出现在输出里（`NC20b`），不许静默；
- 清单坏掉时**不豁免任何东西**（`NC20c`）——坏清单更严，不是更松。

加上权威检查那边的安全阀：说明符如果是**加载期导入形态**（静态 `import` / `export from` /
判不准的 `require`），照旧非零退出——宿主集成只在动态可选形态下成立（突变 M15 钉住）。

### 3. 我改了别人所有权范围内的两个测试文件

Kimi 的 `index-async-wiring.test.mjs` 与我自己范围内的 Fleet 测试。前者按所有权归 Kimi。
我改它的理由：**它在集成时挂死 40 分钟并阻塞门**，属于集成阶段发现的阻断性缺陷；
任务书也要求「完成接线后让非作者复核真实生产入口」，我就是那个非作者。

改动性质要说清楚：**没有放宽它测的属性**。原判据「持锁期间 tick ≥ 10」
在量机器有多闲；新判据 `tick > 0`（被 park 时**恰好**是 0，与负载无关）+ 同进程基线归一。
否证证明新判据在真 park 时仍然变红，而当初误报的那个 7 tick 现在正确判绿。
如果 Kimi 或审查者不同意这个改法，欢迎推翻——但请连带解决那 40 分钟挂死。

---

## 二、反对过自己的地方（以及为什么改）

| 我先做的 | 为什么推翻 |
|---|---|
| 用「历史轮次号不得出现在证据条任何位置」判证据不串 | 真宿主上立刻误报：最旧轮次是 1，而证据条本来就写着「步骤 1」。那条断言测的不是本场景要测的东西，只是撞上一个无关的合法数字。改成内容判别（每跳 prompt 专属原文）并收口到集合相等 |
| 给 404 分支要求 `artifact refused: …` 的拒绝理由 | 该分支的设计就是对内对外都用同一句 `artifact not found`（不做存在性预言机）。硬要理由等于替代码规定它没有也不该有的行为。改回只断言拒绝事实 + kind |
| 按 `gitHead` 判依赖面产物陈旧 | 见上文一.1：会让这层检查永久失效 |
| 依赖清单里只列静态 `import` 扫到的 4 个包 | 完整导入图扫出 `dsh-timeout` 与 `react` 也是真依赖（动态 `import()` 与 CommonJS `require`）。静态匹配漏掉它们，`--check` 就会在缺包时报就绪 |

---

## 三、判断依据：为什么 swarm 不是包依赖

这是本轮**唯一一个架构性决定**，它带来 5 项新 skip，必须交代清楚。

事实（逐版 `npm pack` 实测，不是推测）：
1. registry 上 0.1.0 / 0.1.1 / 0.1.2 的公开导出只有 `Config`、`SWARM_GUIDANCE`、
   `SWARM_SETTINGS_NAMESPACE`、`apply`、`inject`、`renderSwarmResults` 六项。
   AgOS 需要的 `publishProgress` / `parseResultsXml` / `escapeXml` / `textOf` /
   `runNormalizedBatch` / `PROGRESS` **一个都不导出**。
2. 三版的 `lib/index.js:2` 都 `import { installSettingsSection } from '@deepseek-ai/dsh-settings'`。
   该导出只存在于 `dsh-settings` 0.1.0-rc.6 及更早。ESM 具名导入缺失是**加载期 SyntaxError**，
   所以装它就必须把整棵树的 settings 拽回 rc.6，与其余包的 `^0.1.2-rc.1` 冲突——
   **这正是上一轮 `npm ci` 装不出可用树的根因。**
3. 真实宿主上能用的是各 profile 下 `plugins/kimicode-swarm-aligned` 的对齐构建产物。
   该目录只有 `lib/`、没有 `src/`、没有 `.git`——**补丁不可得，构建不可复现**，
   按任务书「确需保留的源码要有可审查来源与可复现构建」的要求，不能 vendor 进仓。
4. swarm 在真实宿主上**本来就是同级插件**（已核实 `~/.dsh/profiles/{desktop,web}`
   均有 `node_modules/dsh-kimicode-swarm`）。

处置分两类，没有混为一谈：
- **纯工具函数**（`escapeXml` / `unescapeXml` / `textOf` / `parseResultsXml`）内联进 Fleet，
  并写了**与真 swarm 的差分测试**（真 swarm 不在场时该测试 skip 并说明原因，不是静默跳过）。
  内联时逐字保留了原实现的怪癖（包括 `parseResultsXml` 的重复键行为），
  否则前端渲染会静默走样。
- **真正的跨插件集成**（`publishProgress` / `runNormalizedBatch`）改为运行期可选：
  `resolveSwarmModule()` 缺席时返回 `{available:false, reason}`，
  Fleet **显式记不可用**（不假装发布过），cn-capabilities 抛可读错误（只影响 plan_run 执行阶段，
  其余 21 个工具不受影响），dsh-agos 的 `overviewLineage()` 返回 `undefined`（概览缺这一节，
  **不伪造零值**）。

**代价我认**：5 项检查从「在混着本地构建产物的树上跑过」变成「在干净树上 skip」。
这不是覆盖的丢失——它们在基线上也从未在干净依赖树里跑过。
恢复覆盖只需 `AGOS_SWARM_MODULE`，skip 消息里写了这句话。

---

## 四、对智谱与 Kimi 成果的复核

### 智谱（`e6c1045`）

核验：基线一致、文件全在 `plugins/dsh-agos/` 所有权内、不含 `index.js`、
9 个新增 / 0 个改既有（语料纪律成立）。cherry-pick 零冲突。

### Kimi（`3c61727`）

核验：基线一致、18 文件 +1765/−183、不含 `index.js` 与任何 `package.json`/lock/frontend。
cherry-pick 零冲突；其提供的 index 接线补丁干净应用；wiring 测试从 `test-wiring/` 移入正式 `test/`。

**作为非作者的否证**（这是任务书要求的那一步）：
- 把 `withLedgerLockAsync` 拆回同步 → 活性测试变红（`无关端点花了 2032ms:事件循环被 park`）；
- 把 `auditFile` 解钉 → pin 测试变红。
恢复后两测皆绿。**接线是承重的，不是摆设。**

**复核发现的两项残留，已修**：
1. 其复核员指出 GET 视图早已剥 `task`/`taskRef`、**POST 没有**。
   `taskRef` 是任务全文的 sha256——漏出去会让 `GET /routes` 成为确认预言机，
   更糟的是客户端能把它回灌、把 unverified 绑定说成 verified。
   七个写路径统一走**递归** `publicize`（递归是必要的：assemble/dispatch 把决策行嵌在字段里）。
   落盘台账照旧记指纹，剥的只是响应。改前实测 2/4 红，改后 4/4 绿。
2. 锁活性测试的负载耦合与 40 分钟挂死，见上文一.3。

---

## 五、这一轮没能解决的

1. **Linux 未验证。** 本机无真实 Linux。弱后端（`linux-unshare`）保持**拒绝**，未放宽。
   Kimi 已把 `buildUnshareArgs` 彻底移除并以 `=== undefined` 钉死，
   planner 永不产出它，手工构造 plan 会被 throw——但这些都只在 macOS 上验过。
2. **`prepare-host-modules` 的 TOCTOU 残留窗口。** 检查与 `open` 之间仍有理论窗口，
   已用 `O_NOFOLLOW` + 打开后复核 `st_dev`/`st_ino` 收口，但不是零窗口。
3. **两个套件依赖 `~/.dsh` 绝对路径**（`dsh-agos-router/http-routes.test.mjs`、
   `index-async-wiring.test.mjs`）。装包解决不了；门在抬头处如实点名。
   下一轮可考虑把它们改造成注入式，但那是 Router 所有权范围。
4. **`dependency-surface.json` 需要人记得重测。** 内容指纹会告诉你它陈旧了，
   但不会自动重测（重测要跑全部套件三种模式，很慢）。这是有意的取舍。

---

## 六、如果我是审查者，会先查这五处

1. `scripts/acceptance/selftest.mjs` 的 **NC11c** ——
   把它删掉，正式门是否重新允许「全部套件缺失 → exit 0」？
2. `scripts/acceptance/run-acceptance.mjs` 的 `preflight()` ——
   把 `stale ? {} : ...` 改成永远 `{}`，NC20a 是否变红？
3. `plugins/dsh-agos/lib/index.js` 的 `attachedFromContext` ——
   把 `available:false` 改成 `attached:false` 直接放行删除，13 项里是否有测试变红？
   （这正是 `host.describe` 腐烂一整轮的那类缺陷）
4. `plugins/dsh-fleet` 远端读取 ——
   把「读字节前绑定实际打开对象」退回按路径 `cat`，fake SSH 的 guard→cat 用例是否变红？
5. `frontend/tests/host-integration/scenarios.mjs` scenario 8 ——
   把 `ctx.blocked(...)` 换回静默 `return`，`verdict-vocabulary` 那 7 项是否变红？

前四处我都跑过否证并留了记录；第 5 处的 5 条否证在 `unit/verdict-vocabulary.test.mjs` 里。

---

## 七、结论

八项任务书条目全部完成并各有否证；新暴露的六项同型问题也已修——
其中两项是**独立复核抓出来的**（含任务书第 6 项我只修对了一半），一项是我自己踩的。
正式门 **1063 pass / 0 fail / 8 skip，exit 0**；真宿主联测 **9/9，0 blocked / 0 skipped**。

**但我不宣布全部验收通过。** 按任务书，这要等独立审查与最终生产接线验证完成。
本文件是自证，自证不是验收。
