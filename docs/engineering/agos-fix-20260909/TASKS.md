# 第三轮任务台账（2026-09-09）

八项任务书条目 + 新暴露的六项。逐条给**判据**和**否证**——
「改了」不算完成，「改坏了会变红」才算。

- 基线：`9434064f87b1a936c13c58b94c2473c6d89f3a61`
- 交付：分支 `fix/cursor-integration-20260909` 尖端；**功能改动最后一跳 `3454a97`**（其后只有文档与一处行尾空格）
- 结果汇总见 [VERIFICATION.md](VERIFICATION.md)

---

## 所有权

| 归属 | 范围 | 提交 |
|---|---|---|
| 智谱（GLM） | `dsh-agos` 的 `session-memory*`、`skills-evolve`、`turn-evidence` 及测试（排除 `index.js`） | `e6c1045` → 本分支 `3cfd497` |
| Kimi | CN autoresearch 模块、Router 源码与测试（排除 `index.js`） | `3c61727` → 本分支 `c38bd47` |
| 主控（本文件作者） | `scripts/acceptance`、依赖清单与锁文件、`frontend` 宿主联测、Fleet、各插件 `index.js`、集成文档 | `b067830`、`d60ae14`、`3454a97` |

三方文件所有权无交叉，两次 cherry-pick **零冲突**。共享入口（各 `index.js`）由主控串行修改。

---

## 1. 验收器自测回归 ✅

**问题**：`selftest.mjs` 默认传不存在的 `--floors`，runner 的 fail-closed 逻辑提前 `exit 78`，
13 项测试根本没执行到目标断言。Luna 实测 1 pass / 13 fail。

**做法**：给合成自测**真实合成 floor**；「缺基线必须失败」单独保留为负例，
生产路径缺基线仍退 78（NC10 系列 a–f）。嵌套 node test 环境传播：为孙子进程斩断
`NODE_TEST_CONTEXT` / `NODE_OPTIONS`（NC17 系列）。

**判据**：selftest **44/44 exit 0**；NC10 系列证明生产缺基线没有重新静默通过。

---

## 2. 正式门完整性 ✅

**问题**：Luna 在临时复制的 runner 里复现——全部插件测试目录缺失时 `tests=0`、`green=true`、`exit 0`。

**做法**：selftest 与依赖树校验接入正式门（`defaultPlan`），哨兵防递归（NC16 系列：
哨兵缺失时**实测**层数增长；哨兵在时停在第 1 层且「自检被排除」不静默）。

**判据**（每条都有**真子进程**负例）：

| 必须失败的情形 | 负控 |
|---|---|
| 整个必需插件 test 目录缺失 | NC11 |
| 目录存在但为空 / 有文件无 `.mjs` | NC11b |
| **全部**必需套件缺失（Luna 原始复现） | **NC11c** |
| 缺 floor 条目 | NC12 |
| 空 / 格式错误的基线 | NC10b / NC10c / NC10d / NC10e |
| 全部 skip | NC13 |
| 测试计数下降 | NC14 |
| 计划里 0 个代码闸 / 必需清单被清空 | NC15 / NC15b |

`defaultPlan` 不再 `continue` 后省略必需套件——缺条目直接判 `missing-floor-entry` 失败。
合成运行自报 `authoritative=false` 且拒绝写基线（NC19），防假套件树洗掉真基线。

---

## 3. 依赖可复现性与安装路径安全 ✅

**问题**：锁文件指向 registry，但绿色 `node_modules` 混着本地 swarm 构建产物和不同版本 settings。

**做法**：
- **拆除不必要依赖**：`dsh-kimicode-swarm` 定性为**宿主环境集成**而非包依赖
  （逐版 `npm pack` 实测证据见 [VERIFICATION.md §4](VERIFICATION.md)）。
  纯工具函数内联（有与真 swarm 的差分测试），`publishProgress` / `runNormalizedBatch`
  改为运行期可选集成，缺席时显式披露降级、不伪造成功。
- 依赖 **11 → 6**；`dsh-timeout` 与 `react` 是完整导入图扫出的真依赖（动态 `import()` 与
  CommonJS `require`，静态匹配漏掉），补进显式声明；`schemastery` 对齐 3.18.1。
- **不用自定义内容摘要替代干净安装证明**：临时目录 `npm ci` 从公开 registry，
  **exit 0，31 包**，无 `--force`、无 `--legacy-peer-deps`，未移动 pin，
  未从 live profile 偷复制补丁依赖。
- `--check` 覆盖**完整静态导入图**，缺包点名文件与行号（G 组 13 项）。
- `prepare-host-modules` 写入前校验祖先**真实路径与所有权**（`O_NOFOLLOW`），
  经 symlink 指向 live profile 一律拒绝且**零字节写入**（W 组 11 项）。
  用假 profile 临时目录复现，**禁止也未碰真实 profile**。

**否证**：M16 突变（清单读不了时静默当空清单）→ NEG-HI-E1..E11 全部变红。
本轮并修正了该突变本身的保真性（原突变是崩溃退出而非 fail-open，见 VERIFICATION §2）。

---

## 4. 宿主联测判定 ✅

**问题**：scenario 8 遇到 `turn-evidence` HTTP 404 时静默跳过，却报告 PASS——
「历史证据隔离已验」这句话来自一次连证据层都没挂载的运行。

**做法**：
- 判定词汇补齐 **pass / fail / blocked / skipped**，未覆盖层点名进汇总；
  `blocked` 不计入 `passed`；`fail` 压过 `blocked`。7 项单元测试 + 5 条否证守着词汇本身。
- scenario 8 在临时宿主**真挂** `turn-evidence`，并以运行中宿主的 **probe** 校验它真的应答；
  没应答就报 `blocked` 并点名。两个可区分轮次的证据通过**实际页面**验证不串：
  判据是内容判别（每跳 prompt 专属原文），收口到集合相等。
- scenario 7 加**可观测重叠屏障**：持住分页响应直到实时事件真的抵达，
  不再以 `Promise.all` 冒充「竞争已测」。

**判据**：真宿主 **9/9，0 blocked / 0 skipped**。实测日志里可见
`the live event landed while the older page was still in-flight (real overlap, not sequential)`
与 `the strip names no other turn's evidence`。

---

## 5. 联测资源管理与日志 ✅

- 跨 chunk token 脱敏：单字节喂入 / 对半切 / 多字节边界 / 内存上限——不完整 token 不提前写盘
- Playwright **拒借 live profile**：显式参数 → 仓库自有依赖树 → 大声 `blocked`。
  本轮为此给 `frontend` 装了钉死的 `playwright-core@1.62.1`（registry，无 `--force`）
- 浏览器**拒绝外部源请求**，实测生效：`blocked external request: GET https://fonts.googleapis.com/...`
- `cleanup` 改为按 **runId + owner token + 进程身份**（拒绝 pid 复用），
  不再按全局 `agos-host-integration` 前缀杀进程删目录
- `createHarness` 在 UI / Playwright / browser 启动失败或中途取消时**逐级回收**，
  含「放弃后才到达的资源」，不依赖尚未返回的 harness 对象
- fake provider + 临时 `DSH_HOME`，**未访问个人会话**；`HOME` / `CODEX_HOME` 一字未动

**判据**：63/63。

---

## 6. 会话删除的真实宿主判据 ✅

**问题**：`dsh-agos/lib/index.js` 仍调用 `host.describe`。

**做法**（先从固定宿主源码找权威信号，再修生产 fallback）：
- `host.describe` 在固定提交 `a66e470204` **全仓零匹配**，vendoring 记录原文写着
  「host.describe removed」——那次内调必然 404 → 删除**永久 503**。已删除该死代码。
- `session.list` → `session/list`（0.1.2 把点号换成斜杠）。
- 挂载权威谓词取宿主自己那一个：`ctx.sessions.get(id) !== undefined`
  （与宿主 `list.ts:172` 逐字一致）。
- 证实 `running` **不能**当挂载判据：宿主对「挂载但空闲」与「磁盘冷会话」
  都产出 `running:false`（`list.ts:125` vs `:178`），二者不可区分。
- **RPC 错误绝不当成「没有挂载」**：状态未知一律拒绝删除，理由带诊断细节。

**判据**：三个生产接线函数此前**零覆盖**（`host.describe` 因此腐烂一整轮），
现已导出并补 13 项测试，覆盖挂载拒绝 / 已分离允许 / 未知状态拒绝；5 条否证全被抓。
联测实际挂载并跑通 AgOS 删除链。

---

## 7. Fleet 远端产物读取 ✅

**问题**：leaf guard 后仍按路径 `stat`/`cat`；probe 与 stream 是两次 SSH；`find` 与 `tar` 之间可替换叶子。

**做法**：probe 与 stream 合并为**单次远端执行**；读任何字节前**绑定并验证实际打开对象**；
缺少远端安全执行能力时**明确拒绝**，不用前后 `stat` 冒充安全打开。

**判据**：fake SSH **真跑 `/bin/sh`** 执行生成命令，覆盖 guard→cat、find→tar、probe→stream、
目录与叶子替换、symlink / hardlink、合法文件正控、GNU stat 分支、无安全执行能力时拒绝。
只读取合成根外 sentinel，**未读真实文件**。上一轮的本地安全打开、锁与生命周期回归保留。
Fleet 177 项：176 pass / 0 fail / 1 skip。

---

## 8. 整合智谱与 Kimi ✅

| 项 | 智谱 | Kimi |
|---|---|---|
| 交接基线 | `9434064` ✓ 与本轮一致 | `9434064` ✓ 与本轮一致 |
| 提交 SHA | `e6c10455c2320fde9f0510ae80fa08964f9ace8e` | `3c61727b32b60f9b058dce134f1a5a854607b9d4` |
| diff | 9 新增 / 0 改既有（语料纪律已验） | 18 文件，+1765 / −183 |
| 所有权核验 | 全在 `plugins/dsh-agos/` 内，不含 `index.js` | 不含 `index.js`、不含任何 `package.json`/lock/frontend |
| cherry-pick | 零冲突 → `3cfd497` | 零冲突 → `c38bd47` |
| index 接线补丁 | 无需 | 已应用（异步锁 + `auditFile` 钉住），wiring 测试移入正式套件 |
| 非作者复核 | 主控复核 | 主控作为非作者**否证**：拆接线两测各变红，恢复即绿 |

**主控复核额外发现并修掉的两项**（都在 Kimi 的范围内，均已否证）：
1. 写路径响应回显 `taskRef`（其复核员指出，GET 已剥、POST 未剥）→ 七个写路径统一递归 `publicize`；
2. 锁活性测试的判据在量机器负载，且失败路径挂死 40 分钟 → 见下方第 9 项。

**没有把未集成的 helper 当最终交付**：两人的成果都已在交付树上、跑在正式门里。

---

## 9. 新暴露并已修（不在任务书八项内）

| # | 问题 | 判据 |
|---|---|---|
| 9.1 | Router「事件循环不被 park」判据用绝对 tick 阈值，实为量机器负载；断言失败还漏 interval 与子进程，挂死 40 分钟 | 改为 `tick > 0` + 同进程基线 1/4；否证：真自旋 0 tick 红、误报的 7 tick 绿、基线 10% 红。清理进 `finally`，同一失败 **3 秒**变红 |
| 9.2 | Fleet 拒绝上报断言 `at(-1)` 耦合事件顺序，负载下被清理事件顶掉 | 改为「存在一条 `refused:true` 且理由/kind 匹配」；否证：拆掉生产端 `refused` 变红；8 路负载连跑 3 次全绿（改前 3 跑红 2） |
| 9.3 | 依赖面预检读陈旧产物报「无缺失」（假绿）；重测后又把优雅降级的套件判缺依赖（假红） | 内容指纹判新旧（NC20d/e/f/g）+ 清单豁免且必须点名（NC20a/b/c），共 7 条真子进程负例 |
| 9.4 | **任务书第 6 项我只修对了一半**：方法名改对了，`payload` 仍缺整个 `args` 层，web profile 删除照样永久 503 | 改为 `payload:{args:{_request:{}}}`（三处独立证据一致）；假 fetch 换成**会校验的假 gateway**（逐字实现宿主两条谓词）+ 元证明负控（四种错形状必须被拒）；否证：形状退回 `{}` 红、键名写成 `request` 红 |
| 9.5 | Fleet 40KB 预览管进 `head`，退出码是 `head` 的 → 拒绝被吞成空的 200（不泄漏，但不诚实） | 单次远端执行 + 判决行先到再定状态码，`limitBytes` 在已持有 fd 上截断；6 项测试走真实路由 handler + stub ssh 真跑生成的 shell；否证：退回 `\| head -c 40000` 时硬链接/符号链接两条红、正控仍绿 |
| 9.6 | 裸 `--write-floors` 被**静默忽略**，输出与不加时逐字相同 → 我以为下限已重算，实际一字未动 | 参数解析处立即退 78（放写盘处会先打完「退出码 = 0」再报错）；NC19c 兼钉「必须在跑任何闸之前退出」；否证：删检查后 NC19c 是唯一变红的一条——正说明此前无人守 |

**9.4 / 9.5 是独立复核抓出来的，9.6 是我自己踩的。** 三者与 9.1–9.3 同一个病根：
断言只覆盖了真实失败面的一部分维度，于是「绿」不等于「对」。9.4 尤其值得记——
我曾据 13 项全绿测试在文档里宣布该项完成，而那 13 项从未看过请求体。

---

## 未做 / 不能做

- **Linux 未验证**：无真实环境。弱后端保持拒绝，未放宽。
- **未 push、未合并 main、未部署、未重启用户 DSH、未调用真实付费模型、未操作真实 Fleet。**
- **未改 `HOME` / `CODEX_HOME`，未安装系统服务。**
- **未提高超时、未删测试、未改标签、未重写基线掩盖失败**——
  计数下限的变化是**上调**（收紧），逐项列在 [VERIFICATION.md §7](VERIFICATION.md)。
- **未为过门读取真实私有语料**，3 项 skip 如实报告。
