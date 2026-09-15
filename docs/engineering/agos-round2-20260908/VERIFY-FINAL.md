# 独立最终验证 — 实测复算、抖动排查、反证与边界审计

验证者：本轮**独立最终验证者**（第一名成功启动的验证者；前一名因模型区域限制未能启动，这道门在本报告之前一次都没跑过）。

- 工作树：`/Users/<name>/Projects/agos-round2-20260908`
- 分支：`cursor/agos-round2-20260908`
- 基线提交：`7e7e359801644b77b302835f374f035e2836926d`
- 环境：macOS darwin 25.5.0，Node v26.7.0，npm 11.19.0，zsh
- 时间：2026-09-09 03:26–03:55（Asia/Shanghai）

## 执行边界与自证

我只写了本文件。所有变异实验都在 `/tmp/agos-mirror`（`rsync` 出的整仓镜像）上做，**镜像里故意不含 `.git` 指针**——因为 `.git` 是 worktree 指针文件，把它复制进 `/tmp` 后 `git status` 之类的读命令仍会解析回主仓 `.git/worktrees/<name>/index` 并可能刷新索引，那是一次仓外写入。镜像内 `git rev-parse` 实测报 `fatal: not a git repository`，确认隔离成立。

自证工作树零改动（开工前后各算一次全树逐文件 md5）：

| 项 | 开工前 | 收工后 |
|---|---|---|
| 逐文件 md5 清单（排除 `node_modules`/`.git`，1637 个文件） | `dd6bfd2077b18084e841bb9fd43ba19b` | `diff` 无差异 |
| `git status --porcelain` 条目数 | 39 | 39 |

未跑任何 git 写命令（无 commit/push/checkout/reset/stash）。未改 `HOME`/`CODEX_HOME`。未跑 `npm install`/`npm ci`。未发起任何模型调用。未动 39411 上的宿主，未连任何 Fleet 机器，未部署。每条变异实验都在改前记 md5、改后跑测、跑完立刻还原并**重新比对 md5**，下文每条反证都附了还原校验结果，全部一致。

---

## 一、独立复算全部测试计数

命令逐条如下，退出码为实测（`echo $?`），计数直接取 `node --test` 的 `ℹ` 摘要行。**我没有抄主控的任何数字**。

插件套件统一用：

```sh
cd plugins/<name> && SESSION_MEMORY_CORPUS_DIR=/tmp/absent DSH_FLEET_RUNS_FILE=/tmp/absent-runs.jsonl node --test test/*.mjs
```

| 套件 | 退出码 | 测试 | 通过 | 失败 | 跳过 | 与主控声称 |
|---|---:|---:|---:|---:|---:|---|
| `dsh-agos` | **0** | 174 | 172 | 0 | 2 | ✅ 一致 |
| `dsh-agos-router` | **0** | 124 | 124 | 0 | 0 | ✅ 一致 |
| `dsh-fleet` | **0** | 148 | 148 | 0 | 0 | ✅ 一致 |
| `cn-capabilities` | **0** | 114 | 114 | 0 | 0 | ✅ 一致 |
| `dsh-mcp-bridge` | **0** | 4 | 4 | 0 | 0 | ✅ 一致 |
| 前端 `npm test` | **0** | 366 | 365 | 0 | 1 | ✅ 一致 |
| **合计** | — | **930** | **927** | **0** | **3** | ✅ 一致 |

其余门：

| 命令 | 退出码 | 实际输出要点 |
|---|---:|---|
| `cd frontend && npm run typecheck` | **0** | `tsc --noEmit` 无输出 |
| `cd frontend && npm run upgrade:dsh:check` | **0** | `upgrade-dsh: pin 0.1.2-rc.1 matches host 0.1.2-rc.1` |
| `node scripts/acceptance/run-acceptance.mjs` | **0** | 五个代码闸全 PASS；`pass 562 / fail 0 / skip 2 (tests 564)` |
| `node scripts/acceptance/verify-host-tree.mjs` | **0** | 两个操作者提供的包均「内容与基准一致」 |

验收闸的通道分离**实测成立**：`deploy-drift` 真实退出码为 **1**，被标为 `ℹ️ ADVISORY`，原样打进摘要（`ADVISORY deploy-drift: exit 1 —— 已记录,不影响代码闸`），进程退出码仍为 0。既没有污染代码闸，也没有被吞掉。

`dsh-agos` 的 2 项跳过我确认**仍是跳过**（`ℹ skipped 2`），没有被计入 `pass`。

一处计数口径要说清：验收闸报的是 564/562，比全套件合计 930/927 少，因为默认计划**不含前端**（前端要 `--with-frontend`）。564 = 174+124+4+114+148，与我逐个套件跑出的插件数完全吻合。

---

## 二、抖动排查

主控声称 `cn-capabilities` 本轮出现过真实抖动（计划文件名同毫秒碰撞，三跑两绿一红），修复后在交付树上连跑五次 5 × 114/0。

### `cn-capabilities` 连跑五次（原始数字）

| 跑次 | 退出码 | 测试 | 通过 | 失败 | 跳过 | 耗时 |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 0 | 114 | 114 | 0 | 0 | 12435 ms |
| 2 | 0 | 114 | 114 | 0 | 0 | 10034 ms |
| 3 | 0 | 114 | 114 | 0 | 0 | 10700 ms |
| 4 | 0 | 114 | 114 | 0 | 0 | 10999 ms |
| 5 | 0 | 114 | 114 | 0 | 0 | 10485 ms |

**五次完全一致，未复现任何抖动。** 主控这一项的声称成立。

### `dsh-agos-router` 连跑三次（原始数字）

| 跑次 | 退出码 | 测试 | 通过 | 失败 | 跳过 | 耗时 |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 0 | 124 | 124 | 0 | 0 | 6196 ms |
| 2 | 0 | 124 | 124 | 0 | 0 | 6209 ms |
| 3 | 0 | 124 | 124 | 0 | 0 | 6144 ms |

**三次完全一致**，耗时离散度极小（6144–6209 ms，<1%），那几条依赖子进程与计时的新测试在本机没有表现出抖动。

### 但抖动排查发现了一件更要紧的事

连跑不红不等于「计时相关的测试都稳」。我在做反证时实测到：`plan-filename-collision.test.mjs` 里那条 `真实生产路径:连续两次建计划都能存盘,且文件名带随机尾`，其**区分力本身依赖负载**——它只在两次连续写落在同一毫秒时才能发现缺陷。同一个变异（把随机尾削成常量），单文件跑 4 次里 2 次报红 2 次放绿，全套件跑 4 次**全部放绿**。详见第四节 M3。

也就是说：这条测试不会造成假红（当前代码正确时它恒绿），但会造成**假绿**——它的保护力在验收闸实际使用的执行模式下为零。抖动被治好了，守住「抖动不再回来」的那条测试却没有稳定的区分力。

---

## 三、逐个反证负例（全部在 `/tmp/agos-mirror` 上做）

先做正控：镜像未变异时，`plan-filename-collision.test.mjs` 6/6、`index-lock-timeout+index-transaction+honesty` 12/12、`session-memory-zh-eval.test.mjs` 9/9、验收闸 564/562 exit 0。确认镜像可复现绿，变异才有意义。

| # | 反证 | 退出码 | 结果 | 报红的测试 / 关键信息 |
|---:|---|---:|---|---|
| 1.1 | `lib/index.js:1940` `planFileName()` → 裸 `` `${PLAN_DIR}/plan-${Date.now()}.json` `` | **1** | ✅ 报红 | `真实生产路径…` + `全生成点扫描…`（2 红）；`计划保存失败: plan file already exists` |
| 1.2 | `:1965` 同上 | **1** | ✅ 报红 | 仅 `全生成点扫描…`（1 红） |
| 1.3 | `:2002` → 字符串拼接 `PLAN_DIR + '/plan-' + Date.now() + '.json'`（主控首轮漏掉的那处） | **1** | ✅ 报红 | 仅 `全生成点扫描…`（1 红） |
| 1.4 | `:2262` 同 1.1 | **1** | ✅ 报红 | 仅 `全生成点扫描…`（1 红） |
| 2 | 自检哨位 `begin`/`end` 放宽到包住整个文件 | **1** | ✅ 报红 | `自检哨位区段 17545 字节,超过上界 1200` |
| 3 | 清空 fixture `ret-08` 的 `pinRefused` | **1** | ✅ 报红 | `ret-08:实际被拒的 pin 与 fixture 的 pinRefused 不符(敏感闸的行为变了)` |
| 4 | `BACKFILL_LOCK`(250ms) → `HTTP_LOCK`(5000ms) | **1** | ✅ 报红 | 读路径那条；`GET /routes 等锁 5036ms`（原 ~340ms，实测断言里 5107ms） |
| 5 | 移除 `ledger-lock.js` `withLedgerLock` 的 thenable 检查 | **1** | ✅ 报红 | `注入点约束…`；`async 回调被静默接受:锁在 promise 创建时就放了` |
| 6 | `index.js` 四处 `withLedgerLock` 接线全改直通 | **1** | ✅ 报红 | 4 项中 **3 红**：`台账里出现了 2 条 outcome`、`只等了 1ms`、`只等了 0ms` |
| 7 | 清空 `dsh-mcp-bridge/test/mcp.test.mjs`，跑验收闸 | **1** | ✅ 报红 | `test-count-regression: tests 1 < floor 4` |

**七条主控列出的反证全部按其声称的方式报红，退出码与关键信息均可复现。** 还原校验：每条改后立刻还原并比对 md5，全部一致。

### 1.1–1.4 的一个重要细节：四处生成点的覆盖强度**不相等**

反证 1.1（行 1940）报了 **2 红**——`真实生产路径` 与 `全生成点扫描` 都抓到了。
反证 1.2/1.3/1.4（行 1965、2002、2262）各只报 **1 红**——**只有源码扫描抓到**。

这意味着四处生成点里有三处**没有任何行为测试走到**，唯一守住它们的是那条对 `lib/index.js` 下正则断言的源码扫描。主控在 VERIFICATION.md 里把这条扫描说成「不依赖语法形状」，我实测证伪了这个说法（第四节 M1b/M5/M6）。

### 追加复核：第四个接线点确实仍无直接覆盖（6b）

主控在 VERIFICATION.md:143 与 HANDOFF 里主动登记「删掉 `transact` 注入本身仍无直接覆盖」。我独立复核：

| 反证 | 退出码 | 结果 |
|---|---:|---|
| 6b 只把 `transact: (fn) => withLedgerLock(…, fn, HTTP_LOCK)` 改成 `transact: (fn) => fn()`，跑**整个** `dsh-agos-router` 套件 | **0** | ❗ **未报红**，124/124 全绿 |

**主控的自我登记是诚实且准确的。** 这一点值得明确表扬：它主动写下了一处对自己不利、且没人要求它写的覆盖缺口，而我复核后发现登记内容与事实完全相符。这条不计为新问题（已如实披露），但它是本轮**真实存在的覆盖缺口**，下一轮必须补。

---

## 四、我自己想出并执行的反证方向（主控没做的）

主控本轮被审查者抓到过两次「反证方向选偏了所以没发现缺陷」。我因此专门挑**主控没试过的绕法**：不去删代码，而是①换语法形状、②削弱而不移除、③攻击闸自身的前提。

### A. 攻击「全生成点扫描」这条正则（cn-capabilities）

扫描的两条模式是 `` /plan-\$\{\s*Date\.now\(\)[^}]*\}[^`]*`/ `` 与 `/'\/?plan-'\s*\+\s*Date\.now\(\)/`，并且**命中里含 `randomInt` 就 `continue`**（视为已修）。

| # | 绕法 | 退出码 | 结果 | 触发的断言 |
|---|---|---:|---|---|
| M1b | 单处（1965）改成**双引号**拼接 `PLAN_DIR + "/plan-" + Date.now() + ".json"` | 1 | ✅ 报红 | **只有负控 `callSites>=4`**（callSites=3）——offender 扫描完全没看见双引号 |
| M6 | 保留全部 4 处调用，另加第五处生成点，**单引号**拼接 | 1 | ✅ 报红 | offender 扫描 |
| **M5** | 保留全部 4 处调用，另加第五处生成点，**双引号**拼接裸 `Date.now()` | **0** | ❗ **未报红**，6/6 全绿 | 一条都没触发 |
| **M3/M7** | 不动生成点，把随机尾削成常量：`randomInt(0, 1_000_000)` → `randomInt(0, 1)`（`randomInt(0,1)` 实测 200 次取值恒为 `0`，零随机性，同毫秒必然重名——**原缺陷完整复活**） | **0** | ❗ **未报红**，全套件 114/114 | 一条都没触发 |

**M5 的意义**：那条扫描不是「与语法形状无关」的——它对引号形状敏感。今天它能抓住 1.2/1.3/1.4，靠的是负控 `callSites >= 4` 恰好因调用点减少而触发，**不是** offender 扫描真的看见了违规写法。只要不减少 `planFileName()` 调用点（例如新功能新增一处写盘），双引号写法可以完全静默地把缺陷带回来。

**M3 的意义（我认为这是本轮最值得处置的一条）**：保留 `randomInt` 但把区间削成常量，同时满足三道闸的字面要求——扫描见 `randomInt` 就跳过、位数断言仍是 19>13、路径闸仍收纯数字尾——而缺陷 100% 复活。量化如下：

| 执行模式 | 跑次 | 结果 |
|---|---|---|
| 单文件 `node --test test/plan-filename-collision.test.mjs` | 4 | 2 次 exit 0（缺陷逃逸）、2 次 exit 1 |
| 全套件 `node --test test/*.mjs`（**验收闸就是这个模式**） | 4 | **4 次全部 exit 0，缺陷 100% 逃逸** |

根因：唯一能发现它的断言是「两次连续建计划不报 `计划保存失败`」，而两次调用是否落在同一毫秒取决于负载。全套件并行跑时负载更高、两次调用被拉开到不同毫秒，于是永远不撞名、永远不报红。

### B. 攻击验收闸自身的前提（计数下限门）

| # | 绕法 | 退出码 | 结果 |
|---|---|---:|---|
| **N1** | 清空 `test/mcp.test.mjs`，**同时**把 `scripts/acceptance/expected-counts.json` 挪走 | **0** | ❗ **闸放绿**。`dsh-mcp-bridge` 被判 `✅ PASS exit 0 pass 1 / fail 0 (tests 1)`，摘要只打一行 `⚠️ 无(expected-counts.json 缺失,删测试抓不到)` |
| N2 | `cn-capabilities` 移走 3 个测试文件，下限文件在位 | 1 | ✅ 拦住，`test-count-regression: tests 63 < floor 114` |

**N1 的意义**：计数下限门是**fail-open** 的。它的全部职责是「抓删测试把闸弄绿」，而删掉它自己的基线文件就能解除这道防线，闸依然退出 0。对比之下同一份代码对缺依赖的处理是明确 fail-closed 的（`missing-host-modules` 判失败、退出码 78、绝不降级成 skip），设计意图显然是「不确定就报红」，唯独下限文件缺席这一路走了相反的姿态。本轮全部改动尚未提交（见第六节 P2-6），基线文件也就没有任何 git 层面的保护。

### C. 攻击「真实 OS 隔离」这条旗舰测试（cn-capabilities Seatbelt）

主控的反证表里**没有任何一条**去动 Seatbelt 沙箱本身，而文档把那条测试称作「真实 OS 隔离，真实子进程，一次断言六项」。我逐项攻击了边界：

| # | 绕法 | 退出码 | 结果 |
|---|---|---:|---|
| S1 | profile 的 `(deny default)` → `(allow default)` | 1 | ✅ 报红，探针实测 `readOutside=false writeOutside=false writeVerifier=false network=false` |
| S3 | env 白名单改成继承 `process.env`（只破「不继承密钥」一项） | 1 | ✅ 报红，`envClean=false` |
| S4 | `file-write*` 放开到整个 evaluator 根（只破「评分文件不可改写」一项） | 1 | ✅ 报红，`writeVerifier=false` |
| S2a/S2b | 生产实际使用的 `sandbox.launcher` 去掉沙箱 / 置 `null` | 1 | ✅ 报红，`THIS HOST: darwin still selects the seatbelt backend and hands back a launcher` |
| S5 | `launcher` 形状保持合法，只把它携带的 profile 换成 `(allow default)`，`sandbox.profile` 字段保持严格 | 1 | ✅ 报红（同上那条） |

**结论：这条声称成立，沙箱是真载荷。** 证据链是闭合的，而且闭合方式很讲究：

- 探针测试走 `sandboxProfile: sandbox.profile`，用**真实 `sandbox-exec` 子进程**证明该 profile 字符串在语义上确实拒读/拒写/拒网络；
- 生产（`autoresearch-workspace.mjs:589`）走 `sandboxLauncher: sandbox.launcher`；
- 两者由 `autoresearch-sandbox.test.mjs:402` 的 `assert.equal(sandbox.launcher.before[1], sandbox.profile)` 钉在一起。

**我要明确纠正自己的一个中间结论**：我最初把 S2 判成「未报红」，那是因为我当时只跑了 `autoresearch-workspace.test.mjs` 这一个文件；跑全套件时 S2a/S2b/S5 都报红。单文件作用域下的绿不是绿——这正是 M3 那条的同一个陷阱，我自己也踩了一次，所以把它写在这里。

### D. 其他

- **`dsh-mcp-bridge` 有一份重复的测试文件**：`plugins/dsh-mcp-bridge/mcp.test.mjs` 与 `plugins/dsh-mcp-bridge/test/mcp.test.mjs` **字节完全相同**（md5 均 `697674a12244406cdb361fe6f49db51d`）。验收闸只 glob `test/*.mjs`，所以计数没有被重复统计（我实测闸报 4，正确）。属卫生问题，非计数问题。

---

## 五、隐私与可复现性边界审计

### 5.1 `logs/final/*.txt` 七份日志

**扫描必须先做正控**——这一点我踩过一次并纠正了：我第一次用 `function` 做正控，得到 0 命中，那是个**无效正控**（测试日志里本来就没有这个词），差点让我把「0 命中」当成扫描有效的证据。换成必然存在的词重做：

| 正控 | 结果 |
|---|---|
| `rg --follow -c 'tests'` | 7 个文件全部命中 |
| `rg --follow -c '✔'` | 365/172/148/124/114/4 —— 与各套件通过数逐一吻合 |
| `wc -lc` | 1072 行 / 92389 字节，无空文件 |

扫描在真的读文件，据此：

| 检查项 | 结果 |
|---|---|
| 个人绝对路径 `/Users/<真名>` | **0 命中** |
| 凭据形状 `sk-`/`gh*_`/`AKIA`/JWT/`xox*`/PRIVATE KEY | **0 命中** |
| 私有会话/目录形状 `.dsh/sessions`、`sessions-trash`、`agos-private`、`fleet-credentials`、`.claude/`、`.Codex/` | **0 命中** |
| 七份日志的 sha256 与 VERIFICATION.md 声称值 | **7/7 逐一吻合**，日志与文档同源、未被事后改动 |

七份日志本身**通过**隐私门。但脱敏声明有一处与文档不符，见第六节 P2-2。另注：`acceptance-gate.txt` 仍含 `/var/folders/40/q3rypsbx6rq34177xts5jk5c0000gn/T/`，那是 macOS 按用户生成的临时目录标识符，非凭据、非姓名，但确属机器/用户级标识（P3-3）。

### 5.2 联测产物的忽略是否生效、是否必要

| 检查 | 结果 |
|---|---|
| `git check-ignore -v frontend/tests/host-integration/artifacts/` | **exit 0**，命中 `frontend/tests/host-integration/.gitignore:12:artifacts/` |
| 目录下 15 个条目逐个 `git check-ignore -q` | **15/15 全部 ignored** |
| 产物是否真含个人路径（证明忽略必要） | **是**，`/Users/<name>` 共 **43** 处 |

逐文件核对主控声称的「43 处」：`host.log` 30 + `results.json` 9 + `probe-host.log` 2 + `run.log` 1 + `probe-host-findings.json` 1 = **43**。**声称精确无误。**

### 5.3 宿主树内容摘要

`node scripts/acceptance/verify-host-tree.mjs` → **exit 0**：

```
✅ dsh-kimicode-swarm@0.1.0  34 文件  内容与基准一致
✅ @deepseek-ai/dsh-settings@0.1.0-rc.6  10 文件  内容与基准一致
```

`scripts/acceptance/host-tree-digests.json` 里的版本号、文件数、树摘要与 DEPENDENCIES.md 表格**逐字段吻合**（`78edb7fb…`、`00f521f8…`）。

### 5.4 两个 pin 文件相对基线是否被改动

**这里有一处任务给定的路径不存在，必须说清，否则我的「无差异」会被读成假证据。**

| 路径 | `git diff 7e7e359` | 判定 |
|---|---|---|
| `frontend/UPSTREAM.pin` | 0 行 | ✅ 未改动 |
| `scripts/acceptance/contract-baseline.sha256` | 0 行 | ⚠️ **该文件不存在**——`ls` 报 `No such file or directory`，基线提交里也没有。空 diff 在这里是**空洞的**，不构成任何证据 |
| `frontend/contract-baseline.sha256`（真实路径） | 0 行 | ✅ 未改动 |

并做了反向正控，证明 `git diff` 对本轮真改过的文件确实会输出：`plugins/dsh-agos-router/lib/index.js` → 164 行。两个 pin 文件的 `git status` 也是干净的。

### 5.5 全仓扫描：是否有测试读操作者真实数据

**软链陷阱的正控（任务特别警示、主控本轮被骗过一次）**——我在 `~/.dsh/profiles/desktop/node_modules/@deepseek-ai/`（每一项都是软链）上用必然存在的词 `function` 对比：

| 扫描方式 | 命中文件数 |
|---|---:|
| `grep -R` | **0**（假的 0 命中） |
| `grep -RL` | 0 |
| `rg`（默认不跟软链） | 0 |
| **`rg --follow`** | **77** |

陷阱真实存在。此后全部扫描一律 `rg --follow`，并对测试目录做正控（`function` 命中 55 个文件）。

结论：

- 仓内 `plugins/node_modules`、`plugins/dsh-mcp-bridge/node_modules`、`frontend/node_modules` **均为实体目录，不是软链**（根 `node_modules` 不存在）。主控关于「摆脱指向个人 profile 的软链」的声称成立。
- 测试文件里所有 `.dsh` 路径都拼在 `mkdtemp()` 出来的临时 home 上（`outcomes.test.mjs`、`session-management.test.mjs`、`skills-studio.test.mjs`、`turn-evidence*.test.mjs`、`skills-console.test.mjs`、`plugins-inventory.test.mjs`），**没有一条落到真实 `~/.dsh`**。`http-routes.test.mjs` 自带 `mkdtemp` 的 `auditFile`。
- **取证确认**：我跑测窗口（03:26–03:51）内，`~/.dsh` 下**被修改的文件数为 0**。整轮验证没有向操作者真实目录写入任何东西。

一处真实的读依赖（已被主控如实记录，不是我的新发现）：验收闸自己每次都打印 `⚠️ 依赖 ~/.dsh 绝对路径的套件: dsh-agos-router/http-routes.test.mjs`。根因在 `outcomes.js:191`——`DSH_FLEET_RUNS_FILE` 与 `DSH_FLEET_LEDGER_PATH` 都缺席时兜底到 `join(home, '.dsh', 'logs', 'fleet', 'runs.jsonl')`。该文件在本机真实存在（6980 字节，权限 `0600`）。也就是说：**裸跑 `node --test test/*.mjs` 而不带环境变量，会读操作者真实 Fleet 批次历史。** 主控在 `scripts/acceptance/lib/exec.mjs:52-62` 与 `wiring/A-wiring.md:83`（实测 `EPERM … runs.jsonl`）都写明了，验收闸也已把变量指向不存在路径来关掉它。属**已披露、已在 harness 层缓解、但套件本身仍非结构自足**，记 P3-1。

### 5.6 本轮**新增**交付文件里的个人路径（新发现）

前一节的结论只覆盖 `logs/final/` 七份日志。把范围放到本轮新增且**未被 gitignore** 的交付文件上，情况不同：

| 文件（本轮新增） | `/Users/<name>` 命中 | 是否被忽略 |
|---|---:|---|
| `scripts/acceptance/dependency-surface.json` | **19** | ❗ 会进仓 |
| `scripts/acceptance/artifacts/logs/*.txt`（6 个） | **6** | ❗ 会进仓 |
| `scripts/acceptance/artifacts/acceptance-results.json` | **1** | ❗ 会进仓 |
| `frontend/scripts/host-integration/host-env.mjs` | **2** | ❗ 会进仓 |
| 合计 | **28** | — |

详见第六节 P2-3、P2-4。作为对照，历史遗留的 `plugins/dsh-agos/test/plugins-inventory.test.mjs:45-46`、`session-trash.test.mjs` 等也含 `/Users/<name>`，但我用 `git cat-file`/`git diff` 确认它们**基线已存在且本轮未改动**，不计入本轮账。

---

## 六、文档诚实度问题清单

先说总体判断：**这批文档处在我读过的同类交付文档里明显偏诚实的一端**，而且是可验证地偏诚实，不是自我表扬：

- VERIFICATION.md 用三种依赖配置的实测对照，把「上一轮 833/0/3 凭什么成立」摊开，并明说本轮数字是重算不是抄；我复算的 930/927/0/3 与它一致。
- 明写 `dsh-agos` 两项跳过「是跳过不是通过」——我确认没有被转成通过。
- 明写「实跑 24 个测试全通过，但这 24 个里没有一个是 Linux 上的真实隔离证据」。
- **主动登记第四个接线点至今无覆盖**——我实测复核（6b）完全相符。
- VERIFICATION.md 里带 `⚠️ 校正` 段落，主动作废自己先前「5 × 108/0」的说法并说明为什么那不构成证据；DEPENDENCIES.md 有整节「校正记录」，主动作废两个复现不出的树摘要，并写下「一个复现不出的摘要比没有摘要更糟——它看起来可验证」。
- DEPENDENCIES.md 的「尚未解决的风险」如实写了 `dsh-fleet` 与 pin 宿主线不兼容、`dsh-kimicode-swarm` 仍不可公网复现，未粉饰。

以下是我实测到的问题，按影响分级。**没有 P1。**

### P2

**P2-1｜`acceptance-gate.txt` 的来源命令与实物不符，且本轮从未捕获过 `--with-frontend` 的运行**
VERIFICATION.md:177 写：「`acceptance-gate.txt` 是 `node scripts/acceptance/run-acceptance.mjs --with-frontend` 的完整输出」。实物里**没有 `frontend-verify` 这个闸**（`rg -c 'frontend-verify'` → 0），闸列表只有 5 个插件 + `deploy-drift`，合计 564 而非 564+366。而 `--with-frontend` 会在计划里追加 `frontend-verify`。进一步：`logs/acceptance/` 目录**是空的**，`logs/` 下没有任何含 `frontend-verify` 的日志。
→ 该日志实际是**不带** `--with-frontend` 的运行；文档命名了一条不可能产出该实物的命令，且「代码闸+前端合并门」这一项本轮**没有任何证据文件**。不影响任何测试数字（564/562 我自己复现了，前端 366/365 与 typecheck 我也单独跑绿），但它是对交付证据来源的误述——正是本轮被反复点名的失误类型。

**P2-2｜`acceptance-gate.txt` 做了脱敏却没有声明，与文档明文承诺相反**
VERIFICATION.md:183-187 写：「`frontend-test.txt`(4 处)与 `acceptance-gate.txt`(1 处)……**这两个文件做了路径前缀脱敏，并在文件头第一行注明**——只替换绝对路径前缀为 `<WORKTREE>` / `<HOME>`」。实测：

| 文件 | 脱敏声明 | 实际脱敏形式 |
|---|---|---|
| `frontend-test.txt` | ✅ 第 1–5 行有完整声明 | `<WORKTREE>` / `<HOME>` 前缀替换，与声称一致 |
| `acceptance-gate.txt` | ❗ **全文 `脱敏` 0 命中**，第一行是闸的横幅 | `/Users/<name>/Projects/…`，是**用户名**替换，不是声称的前缀替换 |

→ 两处不符：一是声明不存在，二是脱敏形式与描述不同。这条尤其要紧，因为该段落**自己**给出的理由是「一份被后处理过却不声明的日志，事后无法与伪造区分」——而 `acceptance-gate.txt` 恰好就是这样一份日志。第三名审查者在 REVIEW-CONTROLLER.md:273 表扬了这处「主动声明」，但只核了 `frontend-test.txt`。

**P2-3｜本轮新增交付文件里有 28 处个人绝对路径，且不被 gitignore**
本轮**正确地**诊断并修掉了联测产物的同类问题（REVIEW.md:419、HANDOFF.md:118：43 处个人路径 → 新建 `.gitignore` 忽略 `artifacts/`，我已验证生效）。但同一标准没有施加到自己新增的交付物上：`scripts/acceptance/dependency-surface.json`(19)、`scripts/acceptance/artifacts/logs/*.txt`(6)、`scripts/acceptance/artifacts/acceptance-results.json`(1)。其中 `scripts/acceptance/artifacts/logs/*.txt` 与被忽略的 `frontend/tests/host-integration/artifacts/` 是**完全同一类东西**——验收运行日志，头部带 `# cwd: /Users/<name>/…`。隐私门的口径应当一致。

**P2-4｜`frontend/scripts/host-integration/host-env.mjs` 把操作者绝对路径写成默认值**
```
export const DSH_BIN = process.env.AGOS_DSH_BIN ?? '/Users/<name>/.npm-global/bin/dsh'
export const PLAYWRIGHT_MODULE = process.env.AGOS_PLAYWRIGHT_MODULE
  ?? '/Users/<name>/.dsh/profiles/web/node_modules/playwright-core/index.js'
```
既是隐私泄露也是可复现性缺陷：换任何一台机器，不显式设两个环境变量就会静默指向不存在的路径。本轮的核心议题正是「上一轮验收不可在干净机器复现」，这里把同一个模式又引入了一次（上一轮是软链，这一轮是硬编码默认值）。

**P2-5｜`TASKS.md` 留着中途数字，与最终状态矛盾**
`TASKS.md:77` 写「`plugins/cn-capabilities/lib/index.js` | 计划文件名加抗碰撞尾（**3 处**）」。实际是 **4 处**（`planFileName()` 调用点实测 4 个，且该测试自带 `callSites >= 4` 负控）。「3 处」恰好是接线审查者发现漏掉第四处**之前**的数字，而漏掉的那处是后果最重的一处。VERIFICATION.md 已正确写成「四处」，TASKS.md 没跟着更新。同段 `:78` 写 `plan-filename-collision.test.mjs` 「新建 **5 项**」，实际 **6 项**。（对照：`:76` 的 `index-transaction.test.mjs`「新建 4 项」实测 4 项，正确。）

**P2-6｜本轮零提交，全部交付停在未提交工作树上**
`git rev-list --count 7e7e359..HEAD` = **0**，`HEAD` 就是基线。若提交将新增/修改 **106** 个文件（16 modified + 90 新文件）。后果有三条实在的：①所有 sha256/树摘要证据没有锚定到任何不可变 git 对象上；②`.gitignore` 的保护只在 `check-ignore` 层面验证过，从未经过一次真实提交检验；③`expected-counts.json` 这类闸的基线文件没有任何版本保护（叠加 P2-7 的 fail-open）。宣布「验收完成」前应当明确这一状态是有意为之还是待办。

**P2-7｜计数下限门 fail-open（第四节 N1，我的新发现）**
删掉/挪走 `scripts/acceptance/expected-counts.json` 后，被清空的测试套件被判 `PASS`，闸退出 0，只打印一行警告。这道门的全部存在理由就是「抓删测试把闸弄绿」，而它可以被删一个文件解除。同一份代码对缺依赖是明确 fail-closed 的（判 fail、退出码 78、拒绝降级成 skip），姿态不一致。建议：下限文件缺失应判失败，或至少让 `--write-floors` 之外的路径把摘要里的 `⚠️` 升级为非零退出。

**P2-8｜抗碰撞修复的守护测试可被「削弱而非移除」绕过（第四节 M3/M5，我的新发现）**
`randomInt(0, 1_000_000)` → `randomInt(0, 1)` 使原缺陷 100% 复活，而全套件 4/4 全绿。文档把这条测试的保护力说得比实际强（VERIFICATION.md:148 只验证了「回退成纯 `Date.now()`」这一种退化方式，:167 又称源码扫描「与语法形状无关」，实测双引号形状看不见）。交付代码本身是正确的，这是**测试强度**与**文档强度**的问题，不是功能缺陷。建议对随机尾的**熵**下断言（例如钉住 `randomInt` 的上界字面量，或直接断言钉死时钟后产出的不同名字数量来自生产 `planFileName`，而不是测试里的本地副本）。

### P3

- **P3-1｜`dsh-agos-router` 套件非结构自足**：环境变量缺席时会读操作者真实 `~/.dsh/logs/fleet/runs.jsonl`（5.5 节）。已披露、已在 harness 缓解，但裸跑仍会碰私有数据。
- **P3-2｜第四个接线点（`transact` 注入）仍无直接覆盖**：我实测复核为真（6b）。主控已如实登记并写入 HANDOFF，不算隐瞒。
- **P3-3｜`acceptance-gate.txt` 含 macOS 按用户生成的临时目录标识符** `/var/folders/40/q3rypsbx6…`。非凭据非姓名，但属用户级标识。
- **P3-4｜`plugins/dsh-mcp-bridge/mcp.test.mjs` 是 `test/mcp.test.mjs` 的字节级重复**（md5 相同）。不影响计数（闸只 glob `test/*.mjs`，实测报 4），纯卫生问题。
- **P3-5｜`DEPENDENCIES.md`「尚未解决的风险」编号错乱**：顺序为 1、2、3(已作废)、**5**、**4**。
- **P3-6｜任务书里 `scripts/acceptance/contract-baseline.sha256` 这个路径不存在**（真实路径为 `frontend/contract-baseline.sha256`）。这是任务给定路径的问题、不是交付物的问题，但若不点明，一个「diff 为空」的记录会被误读成通过（5.4 节）。

---

## 七、我没有验证的事

这一节是我结论的边界。**下列各项我一次都没跑过，任何把它们当成「已验证」的读法都超出了本报告能支持的范围。**

**平台**
1. **Linux OS 隔离执行器：完全未做动态验收。** 我复测 `docker`/`podman`/`colima`/`lima`/`nerdctl` 五项全部 `absent`，本机不可能跑。主控「Linux 未验证」的声称我确认为诚实，但这等于说该后端的运行时行为**至今零证据**。`linux-unshare` 把 `/` remount 成只读而非不可读（沙箱内仍可读 `$HOME`、`/etc`、凭据文件）这条审查者发现，我没有独立复核，也无法复核。
2. **只在 macOS darwin 25.5.0 + Node v26.7.0 上验证。** 其他 OS、其他 Node 大版本、其他 CPU 架构均未覆盖。

**未执行的命令**
3. **`npm run build`**：未跑（会向 `frontend/dist` 写入）。文档的 `✓ built in 619ms` 与那条 chunk 体积警告我没有独立确认。
4. **`npm run vendor:diff`**、**`npm run verify`**（复合门）：均未跑。因此 `--with-frontend` 的合并闸我也没有产出证据——我只是证明了主控的那份日志不是它产出的（P2-1）。
5. **`npm install` / `npm ci`**：按边界禁止。所以 DEPENDENCIES.md 的「干净机器 `npm ci` 可复现」**我完全没有验证**。我只验证了「这台机器上现存的树内容等于基准摘要」，这是两件不同的事。
6. **`npm` registry 公网可得性表**：未发起任何网络请求，DEPENDENCIES.md 的可得性表与 `latest` tag 全部未核。

**未验证的验收项**
7. **真实宿主端到端（B 包，验收项 3）**：未跑。启动 39411 上的真实宿主为边界禁止。B 声称的「真宿主 + 真浏览器 9/9」我**只看了产物文件**（`results.json`/`host.log`/截图存在、含个人路径），没有重跑、没有核对断言、没有验证那 9 个场景真的覆盖了它们的标题。这一项在我这里是**未验证**，不是通过。
8. **上一轮基线 833/0/3 与三配置对照表**：未复算。重建三种依赖配置需要装包，边界禁止。VERIFICATION.md 那张表我一条都没验。
9. **验收清单 12 项**：我逐项验证的只有 #2（代码门/漂移分离）、#6（Linux 维持 `verification-unavailable` 且不谎报）、#7 的 macOS 部分、#12 的文档诚实度。#1、#3、#4、#5、#8、#9、#10、#11 我没有独立验证——只是观察到承载它们的测试在跑且为绿。
10. **`deploy-drift` 的内容**：只确认它退出 1 且被正确隔离在 advisory 通道，**没有**审计它报的漂移内容是否正确。

**覆盖深度**
11. **930 个测试我没有逐条读。** 反证是定向的：只打了主控列出的 7 条 + 我自己挑的 12 条变异。**「其余测试都是载荷」这个结论我给不出**——我只证明了被我打到的那些点。
12. **抖动排查是本机、串行、空载下各跑 5 次/3 次。** 高并发、CI 容器、慢磁盘或不同核数下的抖动未覆盖。M3 的实测恰好说明负载会改变结果，所以这个边界是实在的，不是形式化免责。
13. **前端 `src` 代码本身未审。** 只跑了它的测试与 `tsc --noEmit`。且 `npm test` 只 glob `src/**/*.test.ts`，B 的 `.mjs` 联测夹具既不进 tsc 图也不进 `npm test`——它们的正确性我零覆盖。
14. **多进程/SIGKILL 类测试（验收项 4）我只是跑了它们**，没有独立设计竞争场景去证伪。
15. **`REVIEW.md`/`REVIEW-CONTROLLER.md`/`HANDOFF.md` 我只做了定向核对**（针对可实测的数字与声称），没有逐行审全部 11 万余字。我的 P2/P3 清单是抽样结果，**不是穷尽的**。

---

## 八、最终判定

### 能不能宣布「验收完成」

**工程结论：本轮的代码与测试证据成立。** 我独立复算的 930/927/0/3 与主控声称逐格吻合，五个插件套件 + 前端 + typecheck + 验收闸 + 宿主树校验共 10 条命令**全部**按声称的退出码退出；抖动已治好（5×114/0、3×124/124 零离散）；主控列出的**七条反证全部按其声称的方式报红**；两个 pin 文件相对基线未动；七份最终日志的隐私门干净且 sha256 七分之七吻合；整轮验证没有向操作者真实目录写入任何东西。文档整体可验证地偏诚实，包含多处主动作废自己先前说法、以及一处主动登记对自己不利的覆盖缺口（我复核为真）。

**但不能按现状直接宣布「验收完成」。** 有 **4 项阻塞**需先处置。它们全部是文档/卫生级、不需要改任何插件代码，但都属于本轮被特别授权去消灭的那一类缺陷——「文档或注释说得比代码做到的强」：

1. **P2-1** `acceptance-gate.txt` 的来源命令与实物不符，且本轮从未捕获过任何 `--with-frontend` 运行。改文档描述，或补跑一次并留证。
2. **P2-2** `acceptance-gate.txt` 做了脱敏却无声明，与 VERIFICATION.md 的明文承诺直接矛盾，且违背该段落自己给出的理由。
3. **P2-3 + P2-4** 本轮新增交付文件里 28 处个人绝对路径未被忽略，其中 `host-env.mjs` 把操作者绝对路径写成默认值——与本轮「摆脱个人机器依赖」的核心目标相冲突。
4. **P2-5** `TASKS.md` 的「3 处」「5 项」是中途数字，与最终状态矛盾；「3 处」恰是审查者发现漏修之前的那个数。

另有 **4 项非阻塞但应记入下一轮**：P2-6（零提交）、P2-7（计数下限门 fail-open）、P2-8（抗碰撞守护测试可被削弱绕过）、以及 P3-1～P3-6。

我独立发现、主控与前几名审查者都没有报的新问题共 **6 条**：P2-1、P2-2、P2-3/P2-4（同一类）、P2-7、P2-8、P3-4。

### 必须明确标出的未验证平台

- **Linux OS 隔离执行器：本轮零运行时证据。** 本机五种容器运行时全缺（我复测确认）。仓内 24 个相关测试全绿，但其中**没有一个**是 Linux 上的真实隔离证据。任何「Linux 已验证」的表述都不成立。
- **真实宿主端到端：只在 macOS 上由 B 跑过，我未复核。** 我只看了产物文件的存在与内容形态，没有重跑、没有核对断言与场景标题的对应关系。这一项在我这里是**未验证**，不是通过。
- **干净机器可复现性：未验证。** 边界禁止 `npm install`/`npm ci`，我只能验证「本机现存树内容等于基准摘要」。且 DEPENDENCIES.md 自己如实记着 `dsh-kimicode-swarm` 仍不可公网复现——「摆脱个人 profile 依赖」这个目标本轮**未完全达成**，主控已明写不得声称已解决，我确认这个保留是正确的。
- **其他 OS / Node 版本 / 架构：完全未覆盖。**

### 一句话

代码与测试这道门我判**过**；交付表述这道门我判**未过**，差 4 项文档与卫生级修正。这 4 项不改数字、不改代码，但如果不修就宣布验收完成，本轮恰好会在自己立的那条规矩上失手。
