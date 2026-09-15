# 第四轮最终验收报告（V）

- 验收者：V（只写日志与本报告，未改 `plugins/` / `frontend/` / `scripts/acceptance/*.mjs` 等产品或验收器源码）
- 工作区：`/Users/leo/Projects/agos-cursor-fix-20260909`
- 分支：`fix/cursor-integration-20260909`
- HEAD：`745a0a689b699d79740b5d2c29c400a2d18fef41`（工作树 dirty；候选即这棵未提交树）
- 运行时刻：2026-09-10 08:53–09:00 CST（UTC 00:53–00:59）
- 平台：Darwin 25.5.0 arm64，Node v26.7.0
- 环境：继承 `HOME=/Users/leo`、`CODEX_HOME=/Users/leo/.codex-envs/gpt`（未设回、未改写）
- 正式门：未使用 `--plan`、`--floors=none`、自检哨兵、synthetic override
- 原始日志目录：`/tmp/agos-r4/logs/V-final/`（新建，未覆盖既有失败日志）
- 哈希目录清单：`/tmp/agos-r4/logs/V-final/SHA256.txt`
  `sha256=437795ba470065daa7d89e333ee19c51bfc64ce52677e26301d8728b34601bb2`
  下列每个哈希均为本次 `shasum -a 256` 实算；JSON 内自称的 `logSha256` / `logs[].sha256` 已逐条对过，**0 条不一致**。

---

## 一句话结论

**本地代码门不能宣布通过**：权威正式门 `authoritative: true`、退出码 **1**，`dsh-fleet` 1 fail。
**swarm 独立层在 opt-in 下实跑 19/19 pass**（字节与生产同款，来源不可审计，结论不可传递）；**Linux 独立层 blocked**（本机 Darwin，无可用隔离运行时），`runtime-evidence` 0 pass / 4 blocked。矩阵 `--only=swarm,linux` 因此退 **78**，且明确拒绝「全部验证通过」。

---

## 1. 正式门（权威）

```bash
node scripts/acceptance/run-acceptance.mjs --with-frontend \
  --json=/tmp/agos-r4/logs/V-final/acceptance.json \
  --logdir=/tmp/agos-r4/logs/V-final/acceptance
```

| 项 | 本次实测 |
|---|---|
| 退出码 | **1** |
| `authoritative` | **true** |
| `syntheticSeams` | `null` |
| 自检闸是否在计划里 | 是（`recursionGuard.selftestGateIncluded=true`，哨兵未激活） |
| 合计 | **1252 tests / 1246 pass / 1 fail / 5 skip** |
| 代码闸 | 红（1 个套件不过：`dsh-fleet`） |
| 开始 / 结束 | 2026-09-10T00:53:05Z / 2026-09-10T00:55:44Z |
| JSON | `/tmp/agos-r4/logs/V-final/acceptance.json`  `sha256=e79a4cc94d4daa60b50beef456ad2dea88831097886b61f724fb1d80ff32cb66` |
| 控制台 | `/tmp/agos-r4/logs/V-final/acceptance.console.txt`  `sha256=7d42f41f41a759a565ad7375b68524037baab168a04131e69121b24a791addfe` |

正式门**未**设置 `AGOS_SWARM_MODULE`（按交待的命令原样跑）。同级树解析不到 `dsh-kimicode-swarm`，因此代码闸里那 2 项 swarm skip **仍在**——它们只在独立 swarm 层（见 §3）因 opt-in 变成 pass。

### 1.1 逐闸

| 闸 | verdict | exit | pass | fail | skip | tests | 日志 sha256 |
|---|---|---:|---:|---:|---:|---:|---|
| dsh-agos | pass | 0 | 196 | 0 | 2 | 198 | `73b0275d7f477674fd0c6c98e55881ffffaefde1e11d1bfba14bfd66326b7f13` |
| dsh-agos-router | pass | 0 | 156 | 0 | 0 | 156 | `3ecd7b97018378c86fae9b405b77cb1a44c686c91c9a935e6d06e2785d09bae7` |
| dsh-mcp-bridge | pass | 0 | 4 | 0 | 0 | 4 | `e375c52df6811450718bad28745cf975708da7069d4e9073de90340125833595` |
| cn-capabilities | pass | 0 | 127 | 0 | 1 | 128 | `535a752ab076a93d813aa510898c1c5bc47c7143cd945468c40342d712ea8603` |
| **dsh-fleet** | **fail** | **1** | 182 | **1** | 1 | 184 | `4eff18c8833ee370880634f6aaad14d1618925b95dd80bf3afd596b9838b32bf` |
| frontend-verify | pass | 0 | 365 | 0 | 1 | 366 | `8b3a61483052d3896db0805bad90c5bc81ddf5ed4c410399dd4c2c12bc105c18` |
| selftest | pass | 0 | 51 | 0 | 0 | 51 | `cc223c8d167998c41da78b53c83c8cf99ea69a0aafaf5269c72acefb26b1d810` |
| acceptance-unit | pass | 0 | 64 | 0 | 0 | 64 | `a195cd22da60a0c8e88b71c1d4d2fe9f5c5f6bd3719742e0f094d841e54afad2` |
| integration-unit | pass | 0 | 69 | 0 | 0 | 69 | `c67472eb328c2f9f9a027a8bd64769bcedacd855d58f4846543e57140d697566` |
| linux-layer-unit | pass | 0 | 32 | 0 | 0 | 32 | `7c271ed1a698e927915fb17390c699db84602ffb3c39b667f27afc3e00f511bb` |
| host-modules-check | pass | 0 | — | — | — | — | `720f2c9599bd1a0afd83ff26fce2a4f7c07bf047b8a10e186da22ded2a025a08` |
| host-tree | pass | 0 | — | — | — | — | `3ea5304a60392bd5c7485106c24a2ac43b0adf3a44e4c3f8a1a5dc208ee37f08` |
| deploy-drift | ADVISORY | 1 | — | — | — | — | `a2905179bd4a7d1a6b1c193e47aeaa99a875c6a49cd3aa07485ba69bb584799c` |
| **合计（仅计有 counts 的代码闸）** | **红** | **1** | **1246** | **1** | **5** | **1252** | |

`deploy-drift` 退出 1 是环境事实（未部署分支相对 live profile 漂移），**不参与**进程退出码。预检记录依赖面产物陈旧（指纹 `02046c1ef77d ≠ 5235b1e93883`），按设计**未据此判任何套件失败**；权威依赖判定走 `host-modules-check`（pass）。

### 1.2 skip 逐项点名（5 项，未并入 pass）

| # | 闸 | 测试名 | 原因 | 怎样恢复 |
|---|---|---|---|---|
| 1 | dsh-agos | `W20 尺:四个块各自可评分,并把指标打印出来(只看不进门)` | 未显式指定完整 `SESSION_MEMORY_CORPUS_DIR`，跳过私有语料 | 操作者提供完整真实语料目录。**不为过门去读，也不以人工样本冒充。** |
| 2 | dsh-agos | `W20 acceptEdit 门:语料没动;每条原来通过的样本不得变失败;有提升须显式接受新基线` | 同上 | 同上 |
| 3 | frontend-verify | `explicitly selected parent-session corpus stays distinct` | `CORPUS_ROOT === undefined`（私有语料未授权） | 同上 |
| 4 | cn-capabilities | `real swarm scheduler integration runs the existing fake business scenarios when available` | `host scheduler unavailable`：未解析到同级 `dsh-kimicode-swarm` | 设 `AGOS_SWARM_MODULE` 指向可用模块（独立 swarm 层已这么做，见 §3） |
| 5 | dsh-fleet | `内联的 escapeXml / unescapeXml / textOf / parseResultsXml 与真实 swarm 逐行为一致` | `未覆盖(blocked)`：差分需要真实 swarm 在场；同级解析失败 | 同上 |

前 3 项是主动保留的范围约束。后 2 项在正式门里仍 skip，因为正式门命令没有 opt-in；**不是**磁盘上没有那份模块。

### 1.3 唯一 fail（产品/测试问题，未改代码）

- 位置：`plugins/dsh-fleet/test/farm-integration.test.mjs:300`
- 名称：`early ssh exit with a max-legal prompt is detached without an unhandled stdin EPIPE`
- 断言：`transport exit 255 was not recorded as detached`（`waitUntil` 默认 2000ms 内 ledger 未见 `"ev":"detach"`）
- 同次日志还有测试结束后的 `unhandledRejection`：stub `ssh` 已被 `t.after` 删掉，异步预检仍去跑 `/var/folders/.../dsh-fleet-epipe-.../ssh` → `No such file or directory`
- 该文件**不在**本轮相对 `745a0a6` 的 diff 里

**最小复现（权威口径，红）：**

```bash
cd /Users/leo/Projects/agos-cursor-fix-20260909
node scripts/acceptance/run-acceptance.mjs --with-frontend \
  --json=/tmp/agos-r4/logs/V-final/acceptance.json \
  --logdir=/tmp/agos-r4/logs/V-final/acceptance
# dsh-fleet exit 1；见 acceptance/dsh-fleet.txt
```

**对照（诊断，绿；不是权威）：** 同机随后单独跑该文件，5/5 pass，其中该用例 433ms：

```bash
cd /Users/leo/Projects/agos-cursor-fix-20260909/plugins/dsh-fleet
node --test test/farm-integration.test.mjs
```

日志：`/tmp/agos-r4/logs/V-final/diag/fleet-epipe-rerun.out.txt`
`sha256=c745787f966dae2ae1372f42f19baa820fedf21d0973f8383c8f8ac1f077f012`

倾向：全套件并行时 `process.env.PATH` / 临时 stub ssh / ledger 路径互相踩踏或清理过早。这足以让权威门变红；**V 不把它洗成 pass，也不改测试或产品代码。**

---

## 2. 额外检查

均从工作区根执行。`HOME` / `CODEX_HOME` 仍为继承值。

| 命令 | exit | 计数 | 日志 sha256 |
|---|---:|---|---|
| `node --test "scripts/acceptance/test/*.test.mjs"` | **0** | 64 tests / 64 pass / 0 fail / 0 skip | 输出 `aa38a30a3ecdf251b0e2b6ab7d5430efbec7e5f209625d9253cf63a72afcea30` |
| `node scripts/acceptance/test/mutation-counter-evidence.mjs` | **0** | 23 条突变全部被抓到 | 输出 `a2b467b2de8e5f9cf46d714abe329e884256383284105a08283257a3fb5bda36` |
| `node --test "frontend/tests/host-integration/unit/*.test.mjs"` | **0** | **111** tests / 111 pass / 0 fail / 0 skip | 输出 `43e4cd9371742d84b4cfb80832597ef40684d0af5dc35baf88ed7aa8d3055da0` |
| `git diff --check` | **0** | 无空白问题（空输出） | 输出 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`（空文件） |

`git diff --check 745a0a6` 同样无输出、退出 0。相对基线：21 个已跟踪文件，+1937 / −180；另有未跟踪树 `docs/engineering/agos-round4-20260909/`、`scripts/acceptance/integration/`、3 个 host-integration 新文件。`git status --porcelain` **26** 行（与正式门 `gitDirty: 26` 一致）。

host-unit **111** **不在** `frontend-verify`（仍是 366）里，是单独套件。

---

## 3. 宿主 9 场景（真 Chrome + fake provider）

```bash
node frontend/tests/host-integration/run.mjs --logdir=/tmp/agos-r4/logs/V-final/host
```

| 项 | 本次实测 |
|---|---|
| 退出码 | **0** |
| layer verdict | **pass** |
| 计数 | **9 passed / 0 failed / 0 blocked / 0 skipped** |
| Playwright | `frontend/node_modules/playwright-core` **1.62.1**（repo 树，未借 live profile） |
| 浏览器 | `/Applications/Google Chrome.app` **152.0.7977.82**（已装，未下载） |
| dsh | `/Users/leo/.npm-global/bin/dsh`（installed） |
| 进程身份 | `ps` |
| 结果 JSON | `/tmp/agos-r4/logs/V-final/host/host-browser.json`  `sha256=cb9b2d78cbe41b16b5f5f472b51468e39f0be899aaaa6339b78242db25dce33a` |

`logs[].sha256` 已复核：`results.json` `1576218d…cc6a`、`run.log` `014bbf23…6646`、`host.log` `cc0eea22…e227`。

九场景全部 PASS：`0-bringup` … `8-history-evidence-does-not-leak`。仅 darwin。

---

## 4. swarm 独立层（实跑，不是 blocked）

模块在场：`/Users/leo/Projects/agos-round2-20260908/plugins/node_modules/dsh-kimicode-swarm`
`lib/index.js` 本次实算 `sha256=0a912120a30728164b5d8155544468dc9ca13f70a22d3210ffd15af4af547b71`（与 COVERAGE 记载一致）。

```bash
AGOS_SWARM_MODULE=/Users/leo/Projects/agos-round2-20260908/plugins/node_modules/dsh-kimicode-swarm \
  node scripts/acceptance/integration/swarm/run.mjs --logdir=/tmp/agos-r4/logs/V-final/swarm
```

| 项 | 本次实测 |
|---|---|
| 退出码 | **0** |
| verdict | **pass** |
| 计数 | pass **19** / fail 0 / skip 0 / blocked 0 |
| 入口自检（桩，**不计入** counts） | 10/10 |
| origin | **`local-build`**（opt-in；lockfile 仍写 registry，与磁盘字节不一致） |
| 结果 JSON | `/tmp/agos-r4/logs/V-final/swarm/swarm.json`  `sha256=ac9179a2589223215c2d6c5488e7f7794ff019e5aeadb046bd315919fc0c5173` |

措辞上限见 [COVERAGE.md §2.6](../COVERAGE.md)：用了真实宿主上正在跑的那份字节实跑了 `runNormalizedBatch`；来源不可审计，第三方无法独立复现。**不得**写成可传递的「真实 swarm 集成已验证通过」。

---

## 5. Linux 独立层（blocked）

```bash
node scripts/acceptance/integration/linux/run-linux-isolation.mjs --logdir=/tmp/agos-r4/logs/V-final/linux
```

| 项 | 本次实测 |
|---|---|
| 进程退出码 | **0**（入口把 blocked 记在 JSON，进程仍退 0；矩阵未把它当成 pass） |
| verdict | **blocked** |
| counts | pass **1** / fail 0 / skip 0 / blocked **5** |
| `runtime-evidence` | pass **0** / blocked **4** |
| `decision-logic` | pass 1（不足主机被拒为 `verification-unavailable`，不是内核证据） |
| `vacuous-without-positive-control` | blocked 1 |
| 入口自检（桩，不合并） | 21/21 |
| 结果 JSON | `/tmp/agos-r4/logs/V-final/linux/linux.json`  `sha256=07aa2947c51c568e2ff71ecdbb834eac2754e4a8e6c404e4ea2410b104a21b15` |

`blockedReason` 点名本机：`process.platform=darwin`；7/8 项能力缺失（platform / procfs / kernel-version / namespaces / unprivileged-userns / bubblewrap / mount-primitives）。planner：`verification-unavailable: linux isolation requires a linux host`。

`recoveryCommand` 原文：

```
node scripts/acceptance/integration/linux/run-linux-isolation.mjs --logdir ./linux-layer-logs
```

解除条件仍是：Linux + 内核 ≥ 3.8 + bubblewrap + 非特权 userns；或用户授权装运行时 / 用已有 Linux 主机。本轮约束下不可自行解除。

---

## 6. 矩阵 `--only=swarm,linux` 与 `--print-plan --require=swarm,linux`

### 6.1 实跑矩阵

```bash
AGOS_SWARM_MODULE=/Users/leo/Projects/agos-round2-20260908/plugins/node_modules/dsh-kimicode-swarm \
  node scripts/acceptance/integration/run-matrix.mjs --only=swarm,linux \
    --logdir=/tmp/agos-r4/logs/V-final/matrix \
    --json=/tmp/agos-r4/logs/V-final/matrix.json
```

（`--only` 不会拉代码门和 9 场景。为让 swarm 层与 §4 同一配置，矩阵这次带了同一 `AGOS_SWARM_MODULE`。）

| 项 | 本次实测 |
|---|---|
| 退出码 | **78**（`required-layer-unavailable:linux=blocked`） |
| `authoritative` | **true** |
| `claims.allVerified` | **false**（拒绝「全部验证通过」） |
| 产品代码行 | `skipped(explicitly-skipped)` —— 未把 linux blocked 上卷成产品失败 |
| 集成覆盖 | covered `[swarm]`；blocked `[linux]`；未触达 `[host-browser]`；code-gate 显式 skip |
| 计数合计 | pass 20 / fail 0 / skip 0 / blocked 5 |
| JSON | `/tmp/agos-r4/logs/V-final/matrix.json`  `sha256=df7dec5ea8e59a1a0cd9ed0fe064bf28f28e3a8440044ef857fe8b27cca5379a` |

| 层 | verdict | exit | pass | fail | skip | blocked |
|---|---|---:|---:|---:|---:|---:|
| code-gate | skipped | — | 0 | 0 | 0 | 0 |
| swarm | pass | 0 | 19 | 0 | 0 | 0 |
| linux | blocked | 0 | 1 | 0 | 0 | 5 |
| host-browser | skipped | — | 0 | 0 | 0 | 0 |

矩阵重算了 swarm/linux 的日志哈希，自报一致。

### 6.2 `--print-plan --require=swarm,linux`（文档事实，已确认）

```bash
node scripts/acceptance/integration/run-matrix.mjs --print-plan --require=swarm,linux \
  --logdir=/tmp/agos-r4/logs/V-final/print-plan
```

- 退出码 **78**（`PLAN-ONLY`，一层都没跑）
- `required = [swarm, linux]`，`skipped = []`
- 计划仍 **`run: true`** 四层：
  - `code-gate`：`required=false`，`run=true`（默认 `run-acceptance.mjs`，无 `--with-frontend`）
  - `swarm`：`required=true`，`run=true`
  - `linux`：`required=true`，`run=true`
  - `host-browser`：`required=false`，`run=true`（会拉 9 场景）

输出：`/tmp/agos-r4/logs/V-final/print-plan.out.txt`
`sha256=7f15656708b542a039d6bd79faaf0841d14babf0ac019f74d7b7a5e104ee37c7`

确认：`--require` **不是**「只跑这两层」；只要 swarm+linux、别的不跑，必须用 `--only`。

---

## 7. 与第三轮+Luna 基线（`745a0a6`：1074 / 1069 / 0 / 5，selftest 47）的差异

权威合计从 **1074 → 1252**（+178）、pass **1069 → 1246**（+177）、fail **0 → 1**、skip **5 → 5**。

| 闸 | 基线 tests/pass/fail/skip | 本次 | 解释 |
|---|---|---|---|
| dsh-agos | 198 / 196 / 0 / 2 | 相同 | 2 项私有语料 skip 仍在 |
| dsh-agos-router | 156 / 156 / 0 / 0 | 相同 | |
| dsh-mcp-bridge | 4 / 4 / 0 / 0 | 相同 | |
| cn-capabilities | 120 / 119 / 0 / 1 | **128 / 127 / 0 / 1** | +8：sandbox / workspace / plan-run（含心跳等）。swarm skip 仍 1（正式门无 opt-in） |
| dsh-fleet | 183 / 182 / 0 / 1 | **184 / 182 / 1 / 1** | +1 测试；XML 差分仍 skip；**多 1 fail**（§1.3） |
| frontend-verify | 366 / 365 / 0 / 1 | 相同 | 私有语料 skip 仍在。host-unit 111 **不在此闸** |
| selftest | 47 / 47 / 0 / 0 | **51 / 51 / 0 / 0** | +NC21 / NC21b / NC21c + NC16d（日志里这四条均绿） |
| acceptance-unit | （基线无此闸） | 64 / 64 / 0 / 0 | 本轮接入 `defaultPlan` |
| integration-unit | （无） | 69 / 69 / 0 / 0 | 同上 |
| linux-layer-unit | （无） | 32 / 32 / 0 / 0 | 同上 |

算术核对：`1074 + 8 + 1 + 4 + 64 + 69 + 32 = 1252`。
pass：`1069 + 8 + 0 + 4 + 64 + 69 + 32 = 1246`（fleet 新增的那条没有变成 pass）。

**没有为了绿去改 floors。** `expected-counts.json` 的下限仍低于本次实跑（例如 selftest min 45、cn min 119），门仍因 fleet fail 为红。

5 skip 构成与基线相同：**3 私有语料必须仍 skip**（已点名）；**2 swarm skip 在正式门仍 skip**，因为权威命令未设 `AGOS_SWARM_MODULE`。磁盘模块在场 ≠ 代码闸自动 opt-in。独立 swarm 层设了 opt-in 之后，那 2 项对应的覆盖在 **19 条集成检查**里实跑通过，而不是在正式门计数里变成 pass。

---

## 8. 产品代码问题（发现但不改）

1. **权威门红：`dsh-fleet` farm EPIPE 用例**（§1.3）。未改文件；全套件红、单文件绿。最小复现即正式门命令。不要为了绿重跑正式门或下调 floors。
2. **观察，不是本轮门的失败原因：** Linux 入口 `verdict=blocked` 但进程退出码 0；swarm 入口对 blocked 的约定是退 2。矩阵读 JSON，未把 linux 当成 pass（退 78）。
3. **观察：** 同棵脏树上 `worktreeDigest` 两套算法——host/linux 报 `2e580bdf…`（596 tracked），swarm/矩阵报 `53adbc86…`（dirtyFiles 56）。契约「脏树必须变」两边都声称满足，但跨层不能直接比对摘要。

未发现需要立刻改产品逻辑才能解释的 Linux/swarm 层假绿。host 9/9 与 host-unit 111/111 在本次冻结树上复现。

---

## 9. 交回主控的六项

1. **命令退出码 / 计数 / authoritative**：见 §1–§6。正式门与矩阵均为 `authoritative: true`。正式门 exit 1；矩阵 `--only=swarm,linux` exit 78；`--print-plan --require=swarm,linux` exit 78 且仍排上 code-gate 与 host-browser。
2. **skip / blocked 点名**：正式门 5 skip 见 §1.2。Linux 层 blocked（5 条 runtime 计数 + 本机无运行时）。矩阵显式 skip code-gate 与 host-browser。私有语料 3 项仍 skip。
3. **日志路径 + 实算 sha256**：见各节与 `/tmp/agos-r4/logs/V-final/SHA256.txt`。JSON 自称哈希 0 不一致。
4. **相对基线**：+178 tests，主要来自三道新闸（64+69+32）以及 cn+8 / selftest+4 / fleet+1；fail 0→1；skip 仍 5。
5. **产品问题**：fleet EPIPE 用例在权威全量下失败（§1.3 / §8）；V 未改代码。
6. **一句话：** 本地代码门**不能**宣布通过；swarm 独立覆盖为 opt-in 下 19/19 pass（不可传递）；Linux 独立覆盖为 **blocked**，不是产品代码失败。
