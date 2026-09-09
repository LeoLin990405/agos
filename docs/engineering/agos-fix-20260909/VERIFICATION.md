# 验证记录（第三轮，2026-09-09）

本文件围绕**最终状态**写。历史结论在文末「已作废的历史结论」一节单列并标明作废原因。

- 基线提交：`9434064f87b1a936c13c58b94c2473c6d89f3a61`（第二轮，未上传）
- 交付提交：`e93ce40`（分支 `fix/cursor-integration-20260909`，worktree `/Users/leo/Projects/agos-cursor-fix-20260909`）
- **下面所有数字量在 `d60ae14`**，即代码的最后一跳；其后两跳（`8695099`、`e93ce40`）只动 `docs/`，不改任何被测代码
- 相对基线：84 个文件，+14807 / −1757
- `git diff --check 9434064 HEAD`：**无空白问题**

---

## 1. 正式验收门（权威口径）

`node scripts/acceptance/run-acceptance.mjs --with-frontend` → **退出码 0**

| 闸 | 结果 | pass | fail | skip | tests |
|---|---|---|---|---|---|
| dsh-agos | PASS | 194 | 0 | 2 | 196 |
| dsh-agos-router | PASS | 156 | 0 | 0 | 156 |
| dsh-mcp-bridge | PASS | 4 | 0 | 0 | 4 |
| cn-capabilities | PASS | 115 | 0 | 4 | 119 |
| dsh-fleet | PASS | 176 | 0 | 1 | 177 |
| frontend-verify | PASS | 365 | 0 | 1 | 366 |
| selftest | PASS | 44 | 0 | 0 | 44 |
| host-modules-check | PASS | — | — | — | — |
| host-tree | PASS | — | — | — | — |
| deploy-drift | ADVISORY exit 1 | — | — | — | — |
| **合计** | **绿** | **1054** | **0** | **8** | **1062** |

基线是 927 pass / 0 fail / 3 skip。deploy-drift 退 1 是环境事实（分支未部署），
按设计不参与退出码，也没有被吞——它在输出里单独一行。

日志：[acceptance-gate.txt](logs/acceptance-gate.txt)

### 8 项 skip 逐个点名

| 数量 | 位置 | 原因 | 怎样恢复覆盖 |
|---|---|---|---|
| 2 | dsh-agos | 未指定 `SESSION_MEMORY_CORPUS_DIR`，**私有语料未读** | 操作者显式提供完整语料目录 |
| 1 | frontend | 同上（parent-session 语料） | 同上 |
| 4 | cn-capabilities | `dsh-kimicode-swarm` 不在干净树里（宿主环境集成，见 §4） | 设 `AGOS_SWARM_MODULE` 指向可用 swarm |
| 1 | dsh-fleet | 与真实 swarm 的差分比对需要真 swarm 在场 | 同上 |

前三项即任务书说的「三项私有语料 skip」——**没有为过门去读真实语料**。
后五项是本轮把 swarm 定性为宿主集成的**直接后果**，是新增的 skip，不是原有覆盖的丢失：
这些检查在基线上也从未在干净依赖树里跑过（基线的绿树混着本地 swarm 构建产物）。

---

## 2. 验收器自测 —— Luna 的 P1

`node scripts/acceptance/selftest.mjs` → **44 pass / 0 fail / 0 skip，退出码 0**
（Luna 核查时是 **1 pass / 13 fail**）

日志：[selftest.txt](logs/selftest.txt)

负控编号覆盖：

| 组 | 管什么 |
|---|---|
| NC1–NC9 | 失败不许被洗绿、0 测试不算过、skip 不并入 pass、缺包判失败、`--write-floors` 拒红 |
| NC10 系列（a–f） | 缺基线/空基线/坏 JSON/缺 floors 字段/空 floors/`--floors=none` 逃生阀——**生产缺基线仍退 78** |
| NC11 系列（含 **NC11c**） | Luna 原始复现：**全部**必需套件缺失时绝不能 tests=0 / green=true / exit 0 |
| NC12–NC15 | 缺 floor 条目、全 skip、计数下降、空计划、必需清单被清空 |
| NC16 系列 | 自检接入正式门后的递归：哨兵缺失时实测层数增长；哨兵在时停在第 1 层且「自检被排除」不静默 |
| NC17 系列 | 嵌套 node test 环境传播：为孙子进程斩断 `NODE_TEST_CONTEXT`/`NODE_OPTIONS` |
| NC18–NC19 | 超时判定；合成运行自报 `authoritative=false` 且拒绝写基线 |
| **NC20 系列（a–g）** | **本轮新增**：依赖面预检的清单豁免与内容指纹（见 §4） |

### 元证明：负控本身抓不抓得到

`node scripts/acceptance/test/mutation-counter-evidence.mjs` → **23 条突变全部被抓，退出码 0**

日志：[mutation-meta.txt](logs/mutation-meta.txt)

其中 **M16 本轮被修正**：原突变只替换 `die(...)` 那一行，紧跟的 `throw err` 照常抛，
突变体是**崩溃**退出而不是 fail-open——那 11 条负例是被未捕获异常带红的，
从未验到「静默降级成空清单」这个漏洞本身。现在 `from` 把两行一起吃掉，才是忠实的 fail-open。

---

## 3. 验收器单元测试

`node --test scripts/acceptance/test/*.test.mjs` → **64 pass / 0 fail，退出码 0**

日志：[acceptance-unit.txt](logs/acceptance-unit.txt)

- 导入图 G 组 13 项：完整静态导入图，缺包时点名文件与行号；静态定不了值的动态导入如实披露
- 版本内容 V 组 9 项：宿主树版本与内容校验
- 写入守卫 W 组 11 项：`O_NOFOLLOW`、祖先真实路径与所有权、经 symlink 指向 live profile 一律拒绝且**零写入**
- 宿主集成 H 组：清单缺失/JSON 坏/缺必填字段一律 fail-closed 退 2

---

## 4. 干净依赖安装与依赖面

### npm ci（公开 registry，无 `--force`、无 `--legacy-peer-deps`）

临时目录 `npm ci` → **exit 0，31 个包**；`npm ls --depth=0` **exit 0**，
非 optional 的 UNMET/invalid **0 处**。

```
@deepseek-ai/dsh-llm@0.1.2-rc.1     @deepseek-ai/schemastery@3.18.1
@deepseek-ai/dsh-timeout@0.1.2-rc.1 @openai/codex-sdk@0.147.0
@deepseek-ai/dsh-tools@0.1.2-rc.1   react@18.3.1
```

依赖 11 → 6。日志：[clean-npm-ci.txt](logs/clean-npm-ci.txt)

`dsh-timeout` 与 `react` 是**完整导入图**扫出来的真依赖（动态 `import()` 与 CommonJS `require`，
第一版静态匹配漏掉了），本轮补进显式声明；`schemastery` 对齐 3.18.1。

### 依赖面预检的两个口子（本轮实测暴露，NC20a–g 钉住）

**假绿**：提交里那份 `dependency-surface.json` 测于 2026-09-08 的 `7e7e3598`——比 swarm 解耦还早，
只认识 69 个套件、通篇没有 swarm。门据它报「无缺失」，而它描述的是一棵已经不存在的树。
判新旧现改看**内容**（`lib/surface-inputs.mjs` 的 `inputsDigest`，覆盖各插件 `test/` 与 `lib/`、
宿主依赖树 `package.json`），不看 `gitHead`——产物自己要被提交，按 HEAD 判会「永远陈旧」，
等于把这层预检永久关掉（**NC20f** 专钉这条）。陈旧不硬失败，但降级为参考：
不据此判失败、点名本来会被判谁、写明权威判定在 `host-modules-check`。

**假红**：预检不认 `host-integrations.json`。用当前树重测后它把 cn-capabilities 与 dsh-fleet
判成缺 swarm——而这两套件按设计优雅降级、实跑 exit 0。现在复用权威检查那份清单做豁免，
且豁免必须**点名**出现在输出里（**NC20b**），清单坏掉时不豁免任何东西（**NC20c**）。

### swarm 为什么不是包依赖

registry 上 0.1.0 / 0.1.1 / 0.1.2 逐版 `npm pack` 实测：公开导出只有六项，
AgOS 需要的 `publishProgress` / `parseResultsXml` / `escapeXml` / `textOf` /
`runNormalizedBatch` / `PROGRESS` 一个都不导出；且三版的 `lib/index.js:2` 都
`import { installSettingsSection } from '@deepseek-ai/dsh-settings'`，该导出只存在于
`dsh-settings` 0.1.0-rc.6 及更早，ESM 具名导入缺失是**加载期 SyntaxError**，
会把整棵树的 settings 拽回与其余包 `^0.1.2-rc.1` 冲突的 rc.6——这正是上一轮
`npm ci` 装不出可用树的根因。真实宿主上能用的是各 profile 下
`plugins/kimicode-swarm-aligned` 的对齐构建产物，该目录只有 `lib/`、无 `src/`、无 `.git`，
补丁不可得，故**不 vendor 进仓**。

处置：纯工具函数内联（有与真 swarm 的差分测试，真 swarm 不在场时该测试 skip 并说明），
`publishProgress` / `runNormalizedBatch` 改为运行期可选集成
（`plugins/dsh-agos/lib/swarm-host-integration.mjs`），缺席时**显式披露降级**，不伪造成功。

### 安装路径安全

`prepare-host-modules.mjs` 写入前校验祖先的**真实路径与所有权**（`O_NOFOLLOW`），
经 symlink 指向 live profile 一律拒绝且**零字节写入**。用假 profile 临时目录复现，
**未碰真实 profile**。W 组 11 项覆盖。

> 残留：`inspectWriteTarget` 与实际 `open` 之间仍有理论上的 TOCTOU 窗口。
> 当前实现把窗口压到「检查—打开」两次系统调用之间，并用 `O_NOFOLLOW` + 打开后
> 复核 `st_dev`/`st_ino` 收口。这不是零窗口，如实记在此处。

---

## 5. 真实宿主浏览器联测

`node frontend/tests/host-integration/run.mjs` →
**9 passed / 0 failed / 0 blocked / 0 skipped**

日志：[host-integration.txt](logs/host-integration.txt)

| 场景 | 结果 |
|---|---|
| 0-bringup | PASS |
| 1-approval-accepted-then-decision | PASS |
| 2-decision-before-http-response | PASS |
| 3-failure-then-retry | PASS |
| 4-stale-reply-after-session-switch | PASS |
| 5-connection-drop-and-reconnect | PASS |
| 6-empty-window-still-pages | PASS |
| 7-paging-and-live-tail-merge | PASS |
| 8-history-evidence-does-not-leak | PASS |

### 判定词汇：pass / fail / blocked / skipped

`blocked` 是**第三种结局**，不是 pass 的一个变体：某一层在本环境根本没被触达时用它，
未覆盖的层按名字进汇总。`fail` 压过 `blocked`（断言真坏了不叫「未覆盖」）。
`skipped` 给运行中断后没轮到的场景。7 项单元测试 + 5 条否证守着这套词汇本身。

### scenario 8：从「假绿」到真验

原实现把证据条检查包在 `if (await strip.count() > 0)` 里——`turn-evidence` 路由 404 时
静默跳过，而场景照报 PASS。**报告因此声称验过了证据隔离，而那次运行连证据层都没挂载。**

现在：插件必须在**运行中的宿主上应答**（重新 probe 校验，不是「请求过挂载」就算），
没应答就报 `blocked` 并点名未覆盖层。本次运行插件真的应答了，证据条真的渲染了。

判据用**内容判别**，不是数字出现与否：每跳 prompt 是专属原文（`历史构建 N`），
证据条把本跳 query 原样摆在「问句」后面，于是串轮次就是页面上多出另一段话。
收口到集合相等——**任何**别的轮次都不许出现，不止最旧那轮。

> 第一版判据写的是「历史轮次号不得出现在证据条任何位置」，真宿主上立刻误报：
> 最旧轮次是 1，而证据条本来就写着「步骤 1」。那条断言测的不是本场景要测的东西，
> 只是撞上了一个无关的合法数字。7 例否证（含这个邻近正控）现已全中。

### scenario 7：可观测重叠屏障

用 Playwright `page.route` **持住**分页响应，直到实时事件真的抵达才放行。
本次实测抓到：`the live event landed while the older page was still in-flight (real overlap, not sequential)`。
不再以 `Promise.all` 冒充「竞争已测」。

### 资源与日志

- 跨 chunk 脱敏：单字节喂入 / 对半切 / 多字节边界 / 内存上限——不完整 token 不提前写盘
- Playwright **拒借 live profile**：解析顺序为「显式参数 → 仓库自有依赖树 → 大声 blocked」。
  本轮为此给 `frontend` 装了钉死的 `playwright-core@1.62.1`（registry，无 `--force`），
  实测解析到 `repo:frontend/package.json`，不是 `~/.dsh`
- 浏览器源围栏实测生效：`blocked external request: GET https://fonts.googleapis.com/...`
- cleanup 按 `runId` + owner token + **进程身份**（拒绝 pid 复用），不再按全局前缀杀进程删目录
- `createHarness` 逐级回收，含「放弃后才到达的资源」；本次日志里 `unwind ...: released` 逐条可见
- 全程 fake provider + 临时 `DSH_HOME`，**未访问个人会话**；`HOME`/`CODEX_HOME` 一字未动

---

## 6. 类型、构建、pin

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型 | `npm run typecheck` | 通过 |
| 构建 | `npm run build` | `✓ built in 1.30s` |
| dsh 版本 pin | `npm run upgrade:dsh:check` | `pin 0.1.2-rc.1 matches host 0.1.2-rc.1` |
| vendor 差分 | `npm run vendor:diff` | 线协议常量 `BYTE_EQUAL`，适配器基线核验于 `a66e470204` |

---

## 7. 计数下限基线

从**这次真全绿运行**重新生成（`--write-floors` 只接受全绿运行；基线文件自己写着
「整树转绿后 controller 应当从一次真全绿运行重新生成」）：

| 闸 | 旧 minPass | 新 minPass | 变化 |
|---|---|---|---|
| dsh-agos | 172 | 194 | +22 |
| dsh-agos-router | 124 | 156 | +32 |
| dsh-fleet | 148 | 176 | +28 |
| selftest | 37 | 44 | +7 |
| cn-capabilities | 114 | 115 | +1 |
| dsh-mcp-bridge | 4 | 4 | 0 |
| frontend-verify | 365 | 365 | 0 |

**无一下降。** 这是**收紧**：原来 +22/+32/+28 的余量等于允许删掉那么多测试而门仍然绿，
正是下限机制要堵的洞。

---

## 8. 验证过程中新暴露并已修的三个「测试测的是替身」

这三个不在任务书的八项里——是跑全量验证时被咬出来的，都已修并有否证。

### 8.1 Router 锁活性判据在量机器负载

六套件并行把机器跑满时，`WIRING: 外部持锁期间 host 不被 park` 的「tick ≥ 10」只走了 7 →
报「事件循环被 park」。那是**绝对吞吐**阈值。判据换成两条与负载无关的：
`tick > 0`（单线程循环一旦被同步自旋占住，定时器**恰好**一个都不走）+ 与同进程无锁基线比不得低于 1/4。

否证：真同步自旋 0 tick 判红、当初误报的 7 tick 判绿、基线 10% 仍判红。

更要命的是那次误报**挂了 40 分钟**：`clearInterval` 与持锁子进程回收写在断言之后，
一条断言抛出就把 interval 和子进程漏在世界上，`node:test` 报
`Promise resolution is still pending` 直到 runner 超时。清理移进 `finally`，
同一失败现在 **3 秒**变红。

### 8.2 Fleet 拒绝上报断言耦合了事件顺序

`refusals.at(-1)?.refused === true` 断言的是「拒绝必须是最后一个事件」。
实测（整套件 + 8 路 CPU 负载，三跑复现两次）数组是：

```
[{kind:'tgz', refused:true, error:'artifact refused: symlink'},
 {kind:'tgz',               error:'ssh exit null'}]
```

第 0 条正是要断言的拒绝，第 1 条是清理时 ssh 子进程被杀留下的。机器一忙拆解事件先落。
改成「存在一条 `refused:true` 且理由/kind 匹配」——去掉无意义的顺序耦合，
判别力反而更强（原来那条不看理由）。

否证：拆掉生产端的 `refused` 标志，断言变红。同条件连跑 3 次全绿（改前 3 跑红 2）。

### 8.3 写路径响应回显 taskRef

Kimi 复核员指出 GET 视图早已剥、POST 没有。`taskRef` 是任务全文的 sha256，
漏出去会让 `GET /routes` 成为确认预言机，更糟的是客户端能把它回灌、
把 unverified 绑定说成 verified。七个写路径统一走递归 `publicize`
（递归是必要的：assemble/dispatch 把决策行**嵌在字段里**）。落盘台账照旧记指纹，剥的只是响应。
四项守护测试，改前实测 2/4 红。

---

## 9. 未验证与限制（如实）

1. **Linux 未验证。** 本机只有 macOS，无真实 Linux 环境。弱后端（`linux-unshare`）
   保持**拒绝**状态，未放宽。Linux 上的行为本轮**未经验证**。
2. **私有语料 3 项 skip。** 未为过门读取真实语料。
3. **swarm 相关 5 项 skip。** 需要真实 swarm 在场；`AGOS_SWARM_MODULE` 可恢复覆盖。
4. **`prepare-host-modules` 的 TOCTOU 残留窗口**，见 §4 末。
5. **两个套件依赖 `~/.dsh` 绝对路径**（`dsh-agos-router/http-routes.test.mjs`、
   `index-async-wiring.test.mjs`）——装包解决不了，门在抬头处如实点名。
6. **deploy-drift 退 1**：分支未部署，环境事实，按设计不参与代码闸。
7. **独立审查尚未完成。** 本文件是自证；按任务书要求，
   在独立审查与最终生产接线验证完成前**不宣布全部验收通过**。

---

## 已作废的历史结论

| 历史说法 | 出处 | 作废原因 |
|---|---|---|
| 「验收器自测 14/14」 | 第二轮 HANDOFF | Luna 在交付树上实测为 1 pass / 13 fail。该数字来自另一棵树，不能证明交付。现为 44/44。 |
| 「依赖树可复现，11 个包」 | 第二轮 | 锁文件指向 registry，但绿色 `node_modules` 混着本地 swarm 构建产物与不同版本 settings。现为 6 个包、`npm ci` exit 0。 |
| 「依赖面预检无缺失」 | 本轮 §4 前的中途运行 | 读的是 2026-09-08 测的陈旧产物，描述的是一棵已不存在的树。现按内容指纹判新旧。 |
| 「scenario 8 PASS（历史证据隔离已验）」 | 第二轮 | 证据路由 404 被静默跳过，那次运行根本没挂载证据层。现真挂真验，9/9。 |
| 「M16 突变被 11 条负例抓到」 | 本轮修正前 | 突变体是崩溃退出而非 fail-open，抓到的是未捕获异常。现已改成忠实的 fail-open。 |
