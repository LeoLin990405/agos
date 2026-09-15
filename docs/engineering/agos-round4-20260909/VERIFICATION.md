# 验证记录（第四轮，2026-09-09）

本文件记录**实际执行过的命令、实际的退出码、实际的分项计数、以及证据路径与哈希**。

三条硬纪律：

1. **没有实测就不写。** 未产出的位置一律留 `<待 …>` 标记，不写推测值、不写"预期"当结果。
2. **哈希不手填、不猜测。** 每个哈希都必须是 `shasum -a 256` 实际算出来的。
3. **每个数字都要能指到来源**——哪条命令、哪份日志。指不到的数字删掉。

> 待填标记全表见 [§9](#9-待填标记索引)。用 `rg -n '<待' VERIFICATION.md` 可以一次列全。

---

## 0. 基线（**已核对完成**，本节无待填项）

| 项 | 值 |
|---|---|
| 工作区 | `/Users/leo/Projects/agos-cursor-fix-20260909` |
| 分支 | `fix/cursor-integration-20260909` |
| 接收到的 HEAD | `cf5ee889da1f481323e7e3ecd9bea188d3ad647b` + 10 个未提交修改 |
| **本轮基线提交** | **`745a0a6`** |

`745a0a6` 是把那 10 个**已验收**的未提交修改落成提交，**内容零改动**——
它不引入任何新变更，只是给本轮一个可引用的起点。

### 0.1 三重基线核对（全部通过）

主控在开工前独立执行，三条各自防住不同的作弊面：

| # | 核对方式 | 结果 |
|---|---|---|
| 1 | HEAD 与验收记录比对 | 一致 |
| 2 | `git diff` 快照 sha256 = `774cfefc32051fd196870189c0a7b94c1dfb786dedee46ba4626a889a4901589`，与 `LUNA-EXECUTION-ACCEPTANCE.md` 记录比对 | **逐字符相同** |
| 3 | 596 个 tracked 文件**逐文件** sha256 对照 `phase3/pre-tracked-sha256.txt` | **0 不一致 / 0 多出 / 0 缺失** |

**为什么要三条而不是一条**：第 1 条只证明"提交指针对"，改了工作树照样过；
第 2 条证明"未提交的那 10 项逐字节相同"，但对 tracked 文件被悄悄改动无感；
第 3 条才把整棵工作树钉死。三条合起来的结论是
**本轮起点与第三轮验收当时逐字节相同**，不是"看起来一样"。

---

## 1. 正式验收门（权威口径）

共有三次权威运行，不要混淆时间与用途：前两次是历史记录，第三次是当前验收依据：

1. **V 独立验收（未改代码）**：exit **1**，1252 / 1246 / **1** / 5。唯一红闸是 dsh-fleet farm EPIPE。报告 `logs/V-final-report.md`。
2. **主控复跑（修测试后）**：exit **0**，1252 / 1247 / **0** / 5。`authoritative: true`。只改了 `plugins/dsh-fleet/test/farm-integration.test.mjs`（加长 255→detach 轮询窗，清理前先 `await run`）。**不是** V 签字的绿。
3. **最终冻结复跑（当前验收依据）**：exit **0**，**1268 tests / 1263 pass / 0 fail / 5 skip**，12 个 gate 全过，`authoritative: true`。最终 acceptance 证据位于 `/Users/leo/Projects/agos-analysis/2026-09-10/luna-round4-fixes/verification/final/matrix-code-linux/code-gate.acceptance.json`，JSON SHA-256 为 `311c0c3adde83fb9a479fa5c68f3bff19598d104970293483b4235e5cbd2cfea`。

前两项及其下方命令/表是历史 V 与 controller 记录；当前冻结数字以第 3 次最终复跑为准。
历史 controller 命令：

```bash
node scripts/acceptance/run-acceptance.mjs --with-frontend \
  --json=/tmp/agos-r4/logs/controller-recheck/acceptance.json \
  --logdir=/tmp/agos-r4/logs/controller-recheck/acceptance
```

| 闸 | 结果 | pass | fail | skip | tests |
|---|---|---|---|---|---|
| dsh-agos | pass | 196 | 0 | 2 | 198 |
| dsh-agos-router | pass | 156 | 0 | 0 | 156 |
| dsh-mcp-bridge | pass | 4 | 0 | 0 | 4 |
| cn-capabilities | pass | 127 | 0 | 1 | 128 |
| dsh-fleet | pass | 183 | 0 | 1 | 184 |
| frontend-verify | pass | 365 | 0 | 1 | 366 |
| selftest | pass | 51 | 0 | 0 | 51 |
| acceptance-unit | pass | 64 | 0 | 0 | 64 |
| integration-unit | pass | 69 | 0 | 0 | 69 |
| linux-layer-unit | pass | 32 | 0 | 0 | 32 |
| host-modules-check | pass | — | — | — | — |
| host-tree | pass | — | — | — | — |
| deploy-drift | ADVISORY exit 1 | — | — | — | — |
| **合计（有 counts 的代码闸）** | **绿** | **1247** | **0** | **5** | **1252** |

- 退出码：**0**（`deploy-drift` 不参与）
- `authoritative`：**true**（`syntheticSeams: null`）
- JSON：`/tmp/agos-r4/logs/controller-recheck/acceptance.json`
  `sha256=6a16cd2d322bf8299d78f114c40cfc544a2b4aa9eaca7cd1f325ea903b9e70ff`
- 诊断：`logs/controller-fleet-epipe-flake.md`

### 1.1 skip 逐项点名

`skip` **永不并入 pass**。与 V 点名的 5 项相同（正式门仍未设 `AGOS_SWARM_MODULE`）：

| 数量 | 位置 | 原因 | 怎样恢复覆盖 |
|---|---|---|---|
| 2 | dsh-agos W20 尺 / W20 acceptEdit | 未授权完整私有语料 | 操作者提供真实语料目录；不为过门去读，不以人工样本冒充 |
| 1 | frontend-verify parent-session corpus | `CORPUS_ROOT` 未设 | 同上 |
| 1 | cn-capabilities 真调度器集成 | 同级 `dsh-kimicode-swarm` 未解析 | 独立 swarm 层设 `AGOS_SWARM_MODULE`（V 已 19/19，不可传递） |
| 1 | dsh-fleet XML 差分 | 同上 | 同上 |

其中**私有语料相关的 skip 是主动保留的范围约束**，不是待修缺陷——
见 [COVERAGE.md §4.1](COVERAGE.md)。

---

## 2. 验收器自测（selftest）

| 项 | 值 |
|---|---|
| 命令 | `node --test scripts/acceptance/selftest.mjs` |
| 冻结后结果 | **51 tests / 51 pass / 0 fail / 0 skip**，exit 0（正式门内 `selftest` 闸；与单独 `node --test scripts/acceptance/selftest.mjs` 同一文件） |
| 日志 | 见正式门 JSON 上条；selftest 套件在 `codeGate.suites` |

### 2.1 中途实测（**不是冻结态数字**）

主控在本轮中途实测：selftest 从 **47 → 50 / 50，exit 0**。
新增的三条是 NC21 / NC21b / NC21c，缘由与否证见 [REVIEW.md §0](REVIEW.md)。

⚠️ **这个数字是在 A/B/C/D 仍在改源码时量的，不是冻结态。**
权威数字以 [§2](#2-验收器自测selftest) 表格里冻结后的那次为准。
本节保留它，是因为它是"新增负控确实生效"的时点证据，不是最终结论。

---

## 3. E 自己实测的一项：`measure-dependency-surface.mjs` 的未知参数守卫

这是本文件里**唯一由 E 亲自执行并记录的测量**，因此在此单列，便于复核者区分来源。

命令与结果（工作区根目录，2026-09-09）：

```sh
shasum -a 256 scripts/acceptance/dependency-surface.json
node scripts/acceptance/measure-dependency-surface.mjs --print ; echo "EXIT=$?"
shasum -a 256 scripts/acceptance/dependency-surface.json
git status --porcelain scripts/acceptance/dependency-surface.json
```

| 项 | 实测值 |
|---|---|
| 退出码 | **78** |
| stderr | 点名 `无法识别的参数:--print`，并列出合法参数与危害说明 |
| 是否产生测量输出 | **否**——在任何测量之前退出 |
| `dependency-surface.json` sha256（**运行前**） | `f2c3950b40f1512c4b5ec26190793dfd726504e377bd05c0e2e1b485cfe34cff` |
| `dependency-surface.json` sha256（**运行后**） | `f2c3950b40f1512c4b5ec26190793dfd726504e377bd05c0e2e1b485cfe34cff` |
| `git status --porcelain` 该文件 | **空**（未修改） |

**结论**：修复后的脚本对未知参数早退 78，且 tracked 基线**逐字节未变**。

**这条测量证明什么、不证明什么**：它证明**修复在当前工作树上确实生效**；
它**不**替代 NC21 / NC21b / NC21c——那三条负控还额外覆盖了另外四种参数形态、
裸 `--out`，以及"合法参数不被误伤"的反反证。**更关键的是，
"删掉检查块后负控变红"的削弱反证由主控执行，不在本节**，见 [REVIEW.md §0.5](REVIEW.md)。

---

## 4. 集成层结果（契约 `agos-acceptance/integration-layer@1`）

每层一份 JSON，`blocked` **绝不**被汇总成"整体集成通过"。

| 层 | verdict | pass | fail | skip | blocked | 结果 JSON + sha256 |
|---|---|---|---|---|---|---|
| `swarm` | **受限记录** | 19 | 0 | 0 | 0 | final swarm 证据；来源不可审计 |
| `linux` | **`blocked`** | — | — | — | — | final matrix；Darwin，无运行时，exit 78 |
| `host-browser` | **`pass`（darwin）** | 9 | 0 | 0 | 0 | 首轮结果，源码哈希复核未变 |
| `code-gate` | **`pass`** | 1263 | 0 | 5 | 0 | matrix SHA-256 `1027af970b770d42b7b0bc86b7f92bd311e8fc840e3afd01688b39bd153aff0f` |

`linux` 的 `blocked` 已在最终矩阵复跑中确认（本机为 Darwin，无 Linux 运行时），
依据见 [COVERAGE.md §3](COVERAGE.md)；矩阵 `authoritative: true`、exit 78，整体
`allVerified=false`。

### 4.1 每层必须逐项核对的字段

契约要求的字段里，有四个**最容易变成装饰**，复核时逐层过一遍：

| 字段 | 核对办法 |
|---|---|
| `logs[].sha256` | 随机挑一条，自己 `shasum -a 256` 对一遍。硬规则第 3 条禁止手填 |
| `worktreeDigest` | 工作树 dirty 时**必须变**；不变说明它没在算实际内容 |
| `moduleProvenance` | 依据可验证的来源证据分类；`unavailable` 或 `identical` 对照不能单独推导 `local-build`。本次旧 swarm 产物来源仍不可审计 |
| `blockedReason` | 必须**具体到能被第三方证伪**，见 [REVIEW.md §5.2](REVIEW.md) |

逐层核对结论：本地代码层通过；Linux 仍 blocked；旧 swarm 来源未知/不可审计。矩阵
`authoritative: true` 但 `allVerified=false`。

---

## 5. 真实宿主浏览器联测

| 项 | 值 |
|---|---|
| 命令 | 首轮 host 联测（最终复用，源码哈希核对未变） |
| 结果 | **9 pass**；host unit **117 pass** |
| Playwright 来源 | 见 final 证据根 |
| 浏览器可执行文件 | 见 final 证据根 |
| 日志 | `/Users/leo/Projects/agos-analysis/2026-09-10/luna-round4-fixes/verification/final/` |

**判定纪律**（沿用第三轮）：`loaded !== true` 判 `blocked`，
由此产生的 404 **不是**产品缺陷。

---

## 6. 干净依赖树复现

| 项 | 值 |
|---|---|
| 命令 | `<待实际执行的命令行>` |
| `npm ci` 退出码 | `<待>` |
| 包数 | `<待>` |
| 是否用过 `--force` / `--legacy-peer-deps` | `<待——本轮约束禁止，应为"否">` |
| `npm ls --depth=0` | `<待>` |

---

## 7. 相对基线的改动量

| 项 | 值 |
|---|---|
| 相对 `745a0a6` 的文件数 / 增删行 | `<待冻结后 git diff --stat>` |
| `git diff --check 745a0a6 HEAD` | `<待——应为无空白问题>` |
| 最终交付提交 | `<待——见 HANDOFF.md 关于"不钉会过期的引用"的说明>` |

---

## 8. 第三轮历史基线（**是历史，不是本轮结果**）

放在这里只为对比，**任何一格都不得被复制成本轮结论**。

### 8.1 主控提供的第三轮正式门数字

`authoritative: true`，exit 0：**1074 tests / 1069 pass / 0 fail / 5 skip**

| 闸 | tests | pass | fail | skip |
|---|---:|---:|---:|---:|
| dsh-agos | 198 | 196 | 0 | 2 |
| dsh-agos-router | 156 | 156 | 0 | 0 |
| dsh-mcp-bridge | 4 | 4 | 0 | 0 |
| cn-capabilities | 120 | 119 | 0 | 1 |
| dsh-fleet | 183 | 182 | 0 | 1 |
| frontend-verify | 366 | 365 | 0 | 1 |
| selftest | 47 | 47 | 0 | 0 |
| **合计** | **1074** | **1069** | **0** | **5** |

5 项 skip = **私有语料 3 项 + 真实 swarm 2 项**。

### 8.2 ⚠️ 与第三轮交付文档记录不一致，需主控裁决

第三轮自己的交付文档记录的是**另一组数字**：

| 来源 | tests | pass | fail | skip | selftest |
|---|---:|---:|---:|---:|---:|
| 主控提供（[§8.1](#81-主控提供的第三轮正式门数字)） | 1074 | 1069 | 0 | **5** | **47** |
| `docs/engineering/agos-fix-20260909/VERIFICATION.md:32` | 1071 | 1063 | 0 | **8** | **45** |
| `docs/engineering/agos-fix-20260909/HANDOFF.md:34`（复跑期望值） | 1071 | 1063 | 0 | **8** | 45 |

两组数字来自不同时间点/运行记录，均作为历史保留；不能据此断言是某个
swarm 配置造成的差异。1069/5 相对 1063/8 的变化还包含上一轮实施的 **10 项代码与测试修复**，
因此不能把差异归因于 swarm 是否在场。

- **cn-capabilities**：第三轮文档记 119 tests / 115 pass / **4 skip**；§8.1 记 120 / 119 / **1 skip**。
  第三轮文档明确写着那 4 项 skip 的原因是"`dsh-kimicode-swarm` 不在干净树里"，
  恢复方式是"设 `AGOS_SWARM_MODULE`"。
- **skip 总数 8 → 5**：差的 3 项正好是 swarm 相关。

**两组都保留为历史事实，不指定唯一“正确”数字。**

两组均不得被复制成本轮结果。这符合第三轮定下的规矩：
*"单条事实过期时就地换成新值 + 留一行校正记录，不要静默覆盖。"*
本轮也不把旧 swarm 产物的 19/19 运行记录倒推为第三轮真实覆盖。

---

## 9. 待填标记索引

| # | 位置 | 待填内容 | 依赖谁 |
|---|---|---|---|
| V-1 | [§1](#1-正式验收门权威口径) | 正式门命令行、逐闸计数、合计、退出码、`authoritative`、日志路径与 sha256 | 已完成 |
| V-2 | [§1.1](#11-skip-逐项点名) | skip 逐项点名表 | 主控（冻结后） |
| V-3 | [§2](#2-验收器自测selftest) | 冻结后 selftest 计数与日志 | 主控（冻结后） |
| V-4 | [§4](#4-集成层结果契约-agos-acceptanceintegration-layer1) | 四层 verdict / 计数 / 结果 JSON 与 sha256 | A / B / C / D |
| V-5 | [§4.1](#41-每层必须逐项核对的字段) | 四个易失真字段的逐层核对结论 | 主控 |
| V-6 | [§5](#5-真实宿主浏览器联测) | 联测命令、结果、Playwright 与浏览器来源、日志 | C / D |
| V-7 | [§6](#6-干净依赖树复现) | `npm ci` 退出码、包数、`npm ls` 结果 | 主控（冻结后） |
| V-8 | [§7](#7-相对基线的改动量) | 改动量、`git diff --check`、最终交付提交 | 主控（冻结后） |
| V-9 | [§8.2](#82-第三轮历史数字两次运行均保留差异不得归因于-swarm-配置) | 第三轮两组数字均保留；差异包含上一轮十项修复，不归因于 swarm 配置 | 已修正 |

---

## 10. 需要主控补充的材料

1. **[§8.2](#82--与第三轮交付文档记录不一致需主控裁决) 的裁决**——这是本文件里唯一
   **现在就能解决**的待填项，且不依赖 A/B/C/D。
2. ~~两份探测报告需复制进本轮 `logs/`~~ —— **已完成**（`controller-swarm-provenance.md`、
   `controller-linux-capability-probe.md`，`diff` 确认与 `/tmp` 原文逐字节相同）。
   仍需补其**脱敏口径**与 `SHA256.txt` 条目。
3. 误测量产物（471 增 / 338 删 的那份）在 `logs/` 下的**最终文件名与 sha256**。
4. 本轮日志目录的**脱敏口径**（第三轮是 `<HOME>` / `<REPO>` / `<TMP>` 一次性前缀替换，
   且 `SHA256.txt` 里的摘要是**脱敏后**文件本身的）。本轮若沿用，我在各文件头部照第三轮格式补三行说明。
