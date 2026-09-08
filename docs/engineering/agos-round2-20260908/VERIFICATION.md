# 本轮验证 — 命令、退出码、真实结果与限制

主控单写。进行中：本文件在整合与独立验证完成后补最终结果一节；**在此之前不构成验收结论**。

环境：macOS darwin 25.5.0，Node v26.7.0，npm 11.19.0，zsh。DSH pin `deepseek-harness @ a66e470204 (0.1.2-rc.1)`，`frontend/UPSTREAM.pin` 未改动。

## 本轮基线（不复用上一轮的 833/0/3）

基线在一个**一次性纯净 worktree** 上测得：`git worktree add --detach /tmp/agos-baseline-7e7e359 7e7e359…`。本轮 worktree、上一轮已验收工作区 `/Users/<name>/Projects/agos-cursor-hardening-20260908` 与原始主仓均未被基线测量改动。

命令模板（每个套件一次）：

```sh
cd /tmp/agos-baseline-7e7e359/plugins/<name>
SESSION_MEMORY_CORPUS_DIR=/tmp/agos-absent-corpus-baseline node --test test/*.mjs
```

`SESSION_MEMORY_CORPUS_DIR` 显式指向一个不存在的临时路径，确保默认不读取任何个人语料。

### 三种依赖配置下的真实基线

同一份 `7e7e359` 代码，依赖配置不同结果差别很大。上一轮的数字只在第三种配置下成立。

| 套件 | 无 node_modules | registry 精确 pin | pin + 两个操作者提供的包 |
|---|---|---|---|
| `dsh-agos` | exit 0 · 154/0/2 | exit 0 · 154/0/2 | exit 0 · 154/0/2 |
| `dsh-agos-router` | **exit 1 · 90/1/0**（仅收集到 91） | exit 0 · 91/0/0 | exit 0 · 91/0/0 |
| `dsh-fleet` | **exit 1 · 106/8/0**（仅收集到 114） | **exit 1 · 106/8/0** | exit 0 · **137/0/0** |
| `cn-capabilities` | **exit 1 · 57/3/0**（仅收集到 60） | **exit 1 · 78/4/0** | exit 0 · **82/0/0** |
| `dsh-mcp-bridge` | **exit 1 · 0/1/0** | exit 0 · 4/0/0 | exit 0 · 4/0/0 |
| 前端 `npm test` | 不适用 | exit 0 · 365/0/1 | exit 0 · 365/0/1 |

格式为 通过/失败/跳过。`dsh-agos` 的 2 项跳过需要私有语料，**是跳过不是通过**，本轮继续保持跳过。

第三列是本轮采用的配置，与上一轮记录的 137/137、82/82、91/91、154/2、365/1 完全吻合，因此可以确认基线复现无残余变量。前两列不是缺陷，是**上一轮验收不可在干净机器复现**的直接度量——根因逐层单变量确认过程与内容漂移证据见 [DEPENDENCIES.md](DEPENDENCIES.md)。

日志（配置写在文件名里）：

| 文件 | sha256 |
|---|---|
| [logs/baseline/dsh-agos.registry-pin.txt](logs/baseline/dsh-agos.registry-pin.txt) | `b067a297172b80719248cfebc4dbf7f246fb6521f07ed834e7d45aaf29a455fe` |
| [logs/baseline/dsh-agos-router.no-deps.txt](logs/baseline/dsh-agos-router.no-deps.txt) | `6e30a5160d4ce9917a82f21917e239d99cb20dd2d15ccb06ffd1186535329bc2` |
| [logs/baseline/dsh-agos-router.registry-pin.txt](logs/baseline/dsh-agos-router.registry-pin.txt) | `fe95ca13ac00cbcb9ed75b2d766daeb34300cec3776c7d212621a7fd11010e64` |
| [logs/baseline/dsh-fleet.no-deps.txt](logs/baseline/dsh-fleet.no-deps.txt) | `4290d6343c91d1643ed4ff404f0f9ad8806c2372b19795c47a88a28b678b85c1` |
| [logs/baseline/dsh-fleet.registry-pin.txt](logs/baseline/dsh-fleet.registry-pin.txt) | `44047bde2a1be5d18d2870295973c27b96bd6715a396771779e5bcf39d4bdd35` |
| [logs/baseline/dsh-fleet.vendored.txt](logs/baseline/dsh-fleet.vendored.txt) | `abca1a623c89bb4ce8d1bcf7c85da8ea339fc2d9b3ee066711093e87ace876fe` |
| [logs/baseline/cn-capabilities.registry-pin.txt](logs/baseline/cn-capabilities.registry-pin.txt) | `6be5f0b2572cffe050f6f5930b69c02eb4e2dc4f367c90147d0b31915a04033a` |
| [logs/baseline/cn-capabilities.vendored.txt](logs/baseline/cn-capabilities.vendored.txt) | `bdc6557ef37314e02cdd5e44d8158099020a85e06acac68d41073a366570756c` |
| [logs/baseline/dsh-mcp-bridge.registry-pin.txt](logs/baseline/dsh-mcp-bridge.registry-pin.txt) | `f9958a6d6dd0c54185227f5cde427b7cf2a82b19a54c24a4da60bdd83621c5f5` |
| [logs/baseline/frontend-test.baseline.txt](logs/baseline/frontend-test.baseline.txt) | `02cf6469b03a25657f69fa5df5fbcbb91b5dffb4d2616b2d02a104430f3eeb65` |

### 前端基线门（本轮 worktree，主控执行）

| 命令 | 退出码 | 结果 |
|---|---:|---|
| `npm run upgrade:dsh:check` | 0 | `upgrade-dsh: pin 0.1.2-rc.1 matches host 0.1.2-rc.1` —— **pin 未被移动** |
| `npm run typecheck` | 0 | `tsc --noEmit` 无错误 |
| `npm run build` | 0 | `✓ built in 619ms`。有一条 chunk 体积超 500 kB 的**既有警告**（非错误）|
| `npm test` | 0 | 366 个测试 · 365 通过 / 0 失败 / 1 跳过，与纯净 `7e7e359` 一致 |

`npm run upgrade:dsh:check` 的意义要说清：本轮**没有**通过移动 pin 来让检查通过 —— 它现在仍然指向 `a66e470204 (0.1.2-rc.1)`，且与已装宿主一致。`vendor:diff` 归主控，在共享入口接线完成后与最终全套件一并执行。

### B 的 `.mjs` 夹具不进 tsc 图（已确认，非缺口）

`frontend/tsconfig.json` 的 `include` 只覆盖 `src/**/*.ts(x)`、`scripts/**/*.ts(x)` 与 `vite.config.ts`，而 B 的联测夹具是 `.mjs`（`tests/host-integration/run.mjs`、`scenarios.mjs`、`scripts/host-integration/host-env.mjs`）。主控核对后确认合理、**不改 tsconfig**：`tsc` 未开 `allowJs` 时本来就不检查 `.mjs`，把它们拉进 TS 图要连带改编译选项，收益不抵风险。

但由此要在验收结论里说清一件事：**这些夹具的正确性由它们自己的实跑退出码保证，不由类型检查保证。** `npm run typecheck` 全绿不能被读成「联测夹具已被静态检查过」。同理 `npm test` 只 glob `src/**/*.test.ts`，**不会**跑到 B 的联测 —— 那一套需要真实宿主，必须单独执行。

## 依赖供给（主控执行，实测）

```sh
cd plugins            && npm install   # 45 packages, exit 0, 无 --force / --legacy-peer-deps
cd plugins/dsh-mcp-bridge && npm install   # 17 packages, exit 0
# 干净机器复现:
cd plugins && npm ci   # exit 0(实测于 /tmp/agos-baseline-7e7e359)
cd plugins/dsh-mcp-bridge && npm ci   # exit 0
```

`plugins/node_modules` 与 `plugins/dsh-mcp-bridge/node_modules` 均为**实体目录，不是软链**（已用 `readlink` 与 `-L` 判定核验）。未向 `~/.dsh/profiles/**` 写入，未改 `HOME`/`CODEX_HOME`。

两个不可公网复现的包以 `cp -RL` 解引用成实体副本，来源与树摘要记录在 [DEPENDENCIES.md](DEPENDENCIES.md)。注意 `cp -R` 会保留软链，把解析结果指回 `/Applications`，必须 `-L`——这一点实测踩到过。

## 整合期发现的跨界破坏（已解决，保留度量）

Router 的抗碰撞 ID 改造在**中间态**不被前端的严格形状校验接受，主控在中途快照里捕获到：

- `frontend/src/components/console/routes-assemble.ts:131` `const ASSEMBLE_ID_RE = /^asm-\d{1,20}$/`
- 中间态 ID 形如 `dec-1788868808611-55f7e70f83adf3a9457ca9f96f6a8d66`（hex 尾）
- 后果：`parseAssemblePlan` 取不到 `id`，界面落到「提案编号未采集，无法指定试跑对象」

| 时点 | 前端 `npm test` | 结果 |
|---|---:|---|
| 纯净 `7e7e359` | 0 | 365 通过 / 0 失败 / 1 跳过 |
| C 中间态（破坏期） | **1** | 362 通过 / **3 失败** / 1 跳过，均在 `src/components/console/routes-assemble.runtime.test.ts` |
| C 定稿后（当前） | 0 | 365 通过 / 0 失败 / 1 跳过 |

C 自行按前缀分了两种尾编码解决：`dec-` 用满 128 位 hex（插件内部），`asm-`/`dsp-` 保持纯数字并卡在前端既有 20 位预算内（13 位时间戳 + 7 位随机）。**因此前端 `src` 本轮无需改动**，主控原先准备的正则放宽没有实施。判定依据与强度取舍见 [REVIEW.md](REVIEW.md) 的 I1。

## 真实 OS 检查 vs 静态检查的分界（D 包，主控核验）

本轮明确要求区分「真实宿主/真实 OS 检查」与「仅 fake 或静态检查」。D 包的分界如下，已逐项核验：

| 平台 | 性质 | 证据 |
|---|---|---|
| macOS Seatbelt | **真实 OS 隔离，真实子进程** | `test/autoresearch-workspace.test.mjs:432` 真 spawn `node probe.cjs` 进 seatbelt profile，一次断言六项：根外读、根外写、评分文件写、环境继承、scratch 可写、loopback 网络；`:490` 真实回收整个进程组并按 pid 断言无孤儿；`:381` 评分材料不可改写 |
| Linux | **未动态验收**，仅能力检测与 fail-closed 决策逻辑 | 本机 `docker`/`podman`/`colima`/`lima`/`nerdctl` 五项全缺 |

D 的测试自带标注纪律，主控认可并沿用：文件头明确声明「本文件没有任何测试真的 spawn 过 bwrap 或 unshare，不得被当作 OS 隔离的证据」；测试名分三档 —— `STATIC:`（argv 形状断言）、`DECISION LOGIC:`（注入假探测的能力决策）、`THIS HOST:`（本机真实探测）。其中 `THIS HOST: the real probe finds no linux isolation, so the linux path stays unproven` 就是本轮要求的 `verification-unavailable` 姿态。

`plugins/cn-capabilities` 实跑 24 个测试全通过，但**这 24 个里没有一个是 Linux 上的真实隔离证据**。

## 接线后的真实结果（主控执行，B / F2 与独立审查仍在进行）

命令与基线同一模板，`SESSION_MEMORY_CORPUS_DIR` 指向不存在的临时路径：

```sh
cd plugins/<name> && SESSION_MEMORY_CORPUS_DIR=/tmp/agos-absent-final node --test test/*.mjs
cd frontend && npm test
```

| 套件 | 退出码 | 测试 | 通过 | 失败 | 跳过 | 相对基线 |
|---|---:|---:|---:|---:|---:|---|
| `dsh-agos` | 0 | 174 | 172 | 0 | 2 | +18 |
| `dsh-agos-router` | 0 | 124 | 124 | 0 | 0 | +33 |
| `dsh-fleet` | 0 | 148 | 148 | 0 | 0 | +11 |
| `cn-capabilities` | 0 | 114 | 114 | 0 | 0 | +32 |
| `dsh-mcp-bridge` | 0 | 4 | 4 | 0 | 0 | 0 |
| 前端 `npm test` | 0 | 366 | 365 | 0 | 1 | 0 |
| **合计** | — | **930** | **927** | **0** | **3** | **+94** |

（2026-09-09 终值。相比中途快照 `dsh-agos-router` +4、`cn-capabilities` +1，
均为处置接线审查者发现时新增的测试：读路径锁预算、async 回调闸、全生成点扫描、
以及两条把「为什么这条测试有区分力」钉成可执行的行数断言。）

基线合计恰好是 833 通过 / 0 失败 / 3 跳过，与上一轮记录吻合 —— 但**这是本轮实测重算的，不是抄旧数字**，且只在「pin + 两个操作者提供的包」这一种依赖配置下成立（见上文三配置对照）。

`dsh-agos` 的 2 项跳过需要私有语料，**仍是跳过，没有被转成通过**。

### 主控接线的反证（关键：证明接线不是裸奔）

接线本身若无测试守护，等于没接。主控为此逐点反证，全部在 `/tmp` 镜像上做，仓内未改动：

| 反证 | 命令 | 结果 |
|---|---|---|
| router 接线全改直通（**接线前的状态**）| `node --test test/*.mjs` | **exit 0 · 116/116** —— 说明接线原本完全没有测试覆盖 |
| 补测后再改直通 | `node --test test/index-transaction.test.mjs` | **exit 1 · 4 项中 3 红**：`只等了 0ms`(shadowLink)、`只等了 1ms`(backfillShadow)、`台账里出现了 2 条 outcome`(recordOutcome) |
| 隔离删掉 `transact` 一行 | `node --test test/*.mjs` | **exit 0 · 120/120** —— 第四个接线点当时**无覆盖**，如实登记（现已由下方 async 回调闸间接约束，但「删掉注入」本身仍无直接覆盖，见 HANDOFF 下一轮） |
| 计划文件名回退为纯 `Date.now()` | `node --test test/plan-filename-collision.test.mjs` | **exit 1**，报 `只有 13 位数字(纯时间戳)` |
| 语料自检哨位区段外注入个人路径 | `node --test test/session-memory-zh-eval.test.mjs` | **exit 1**，报 `命中禁止形状:个人 home 路径` |
| 删掉自检起始哨位 | 同上 | **exit 1**，报 `自检哨位注释缺失或次序颠倒,评测器自扫已失效` |

处置接线审查者发现时新增的反证（同样在 `/tmp` 镜像上做）：

| 反证 | 结果 |
|---|---|
| 四处计划文件名生成点**逐个**回退（含主控原先漏掉的字符串拼接形状） | 全部 **exit 1**，扫描在失败信息里点名该行 |
| 自检哨位放宽到包住全文（审查者实测能绕过的那条路径） | **exit 1**，报 `自检哨位区段 16692 字节,超过上界 1200` |
| 清空 fixture 的 `pinRefused` | **exit 1**，报 `实际被拒的 pin 与 fixture 的 pinRefused 不符(敏感闸的行为变了)` |
| 回填改回写路径的 5s 预算 | **exit 1**，`GET /routes` 等锁从 342ms 变 5106ms |
| 移除 `withLedgerLock` 的 thenable 闸 | **exit 1**，报 `async 回调被静默接受:锁在 promise 创建时就放了` |


### pin 与契约基准相对基线未改动（复核后的真实结论）

| 文件 | 基线树中存在 | `git diff 7e7e359 -- <path>` |
|---|---|---:|
| `frontend/UPSTREAM.pin` | 是（blob `75ae7bf8`） | 0 行 |
| `frontend/contract-baseline.sha256` | 是 | 0 行 |

⚠️ **这条检查此前是空洞的。** 任务书给的路径是 `scripts/acceptance/contract-baseline.sha256`，
该文件**不存在**；对不存在的路径跑 `git diff` 返回空，而主控把这个空当成了「未改动」。
独立验证者（P3-6）点出了这一点。真实路径是 `frontend/contract-baseline.sha256`，
已用它复核：文件确实在基线树中，diff 确实为 0，**结论不变但现在是真的验过了**。

这是本轮第二次踩同一个坑：把「命中 0 / diff 为空」当证据，而没先确认扫描对象存在。
第一次是 `host.describe` 的 `grep -R` 不跟随软链（见 [REVIEW.md](REVIEW.md) 的 I4 证据重做）。
两次的共同修法是**先跑正控**：确认工具在这个对象上确实能看见东西，再解读它的「没看见」。

### 最终测试日志与 SHA256

日志在 [logs/final/](logs/final/)，由下列命令原样输出（本轮**最终**一批，非中途快照）：

| 文件 | 退出码 | sha256 |
|---|---:|---|
| [dsh-agos.txt](logs/final/dsh-agos.txt) | 0 | `5732fe9aee6cd027fe8f091fdea927c0e1f22eaf448837a7edbc66f1066238ba` |
| [dsh-agos-router.txt](logs/final/dsh-agos-router.txt) | 0 | `8b2d518e4d95b9bcc536f875324147592f21a15bd885f51655ba36efa6b5b740` |
| [dsh-fleet.txt](logs/final/dsh-fleet.txt) | 0 | `f461ce6af62ae5040e366a572f8efabad45c09188174c0e948079e1b34f826d6` |
| [cn-capabilities.txt](logs/final/cn-capabilities.txt) | 0 | `66409034669bc97511134928594911b02a75d9470eaea15d60c06b1a1256d3dd` |
| [dsh-mcp-bridge.txt](logs/final/dsh-mcp-bridge.txt) | 0 | `0e64c8097e1ae17b9d8b282f08fe74a30b701149789c174dafb0e2ee3cc30d63` |
| [frontend-test.txt](logs/final/frontend-test.txt) | 0 | `be3c8baa044d66c8667e229d2a092f16e4b8eacaffb5e86ad629ebe47efb7500` |
| [acceptance-gate.txt](logs/final/acceptance-gate.txt) | 0 | `96ee1cdbf6e9c4de89bdd669992d40fd57bf18866a4aaeafe88984bd7a131cb1` |

插件套件跑的是 `SESSION_MEMORY_CORPUS_DIR=<不存在> DSH_FLEET_RUNS_FILE=<不存在> node --test test/*.mjs`，
即**不读私有语料、不读操作者真实 Fleet 批次历史**；`acceptance-gate.txt` 是
`node scripts/acceptance/run-acceptance.mjs --with-frontend` 的完整输出，含计数下限门与部署漂移分通道。

发布前逐个扫过个人路径与凭据形状（`/Users/<name>`、`sk-…`、`AKIA…`、`gh*_…`、PRIVATE KEY），
七个文件现在**全部为 0 命中**。

其中两个文件需要处理：`frontend-test.txt`（4 处）与 `acceptance-gate.txt`（1 处）会把绝对路径打进输出
（`node --test` 与验收入口都会打印仓库路径），不含任何凭据或会话档案。**这两个文件做了路径前缀脱敏，
并在文件头第一行注明**——只替换绝对路径前缀为 `<WORKTREE>` / `<HOME>`，测试名、断言、计数与退出码
一字未动。

⚠️ **校正（2026-09-09）**：原先这里写「其余五个文件未经任何处理」。独立验证者（阻塞项 2）指出 `acceptance-gate.txt` 做了脱敏却无声明，与本段承诺矛盾。重新捕获时把口径统一了：**七个文件全部经过同一套路径前缀替换**，五个插件日志本身不含个人路径（替换后逐个校验命中 0），`acceptance-gate.txt` 与 `frontend-test.txt` 在文件头声明了脱敏范围。也就是说现在没有「处理过但没说」的文件。之所以把脱敏写进文件本身而不是只写在这里：一份被后处理过却不
声明的日志，事后无法与伪造区分。

### 抖动治理

`cn-capabilities` 在接线前连跑三次得 108/0、108/0、**107/1**。根因是计划文件名同毫秒碰撞（见 [REVIEW.md](REVIEW.md) 的 I7），修复后在**交付树**上连跑五次 **5 × 114/0**（2026-09-09）。这一项被单独记下来，是因为「跑一次绿」在有抖动的套件上不构成证据。

⚠️ **校正**：此处原先写「5 × 108/0」。交付树是 114 个测试（108 + `plan-filename-collision.test.mjs` 的 6 项），也就是说那五次连跑发生在新测试文件加入之前，「抖动消失」这个结论当时并没有在交付树上被验证过 —— 接线审查者 F2 指出这违反了同一句自己立的规矩。现已在交付树上重跑五次，全部 114/0。

## 本节尚未包含

- 各实施包的最终测试结果（待整合与独立验证）
- 真实宿主端到端验收结论
- Linux 沙箱动态验收（本机无任何容器运行时，见下）
- 生产构建、`vendor:diff`、部署漂移报告
- 独立审查与独立验证的结论

## 已知平台限制

本机 `docker`、`podman`、`colima`、`lima`、`nerdctl` 全部缺失（`command -v` 五项均返回 absent，已复测两次）。因此 **Linux OS 隔离执行器本轮不可能动态验收**，只能覆盖能力检测与 fail-closed 决策逻辑。任何声称 Linux 已验证的结论都是不成立的。

本轮**未**为此安装任何容器运行时或系统级服务 —— 执行边界明确禁止擅装。补齐 Linux 动态验收所需的最小环境写在 [HANDOFF.md](HANDOFF.md)。
