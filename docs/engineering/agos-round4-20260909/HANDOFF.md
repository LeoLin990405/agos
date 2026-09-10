# 交接（第四轮 → 下一轮，2026-09-09）

> 待填标记全表见 [§8](#8-待填标记索引)。用 `rg -n '<待' HANDOFF.md` 可以一次列全。
>
> 八项及三个相邻边界的本地代码修复已通过两路独立复审，可签收。
> **最终 code-gate**：12 gate 全过，`authoritative: true`，1263 / 0 / 5。
> V 自己的独立运行仍是红（1246 / 1 fail），见 `logs/V-final-report.md`。
> 最终矩阵 code-gate/Linux 为 `authoritative: true`，Linux `blocked`（Darwin），exit 78，`allVerified=false`。
> 旧本地 swarm 19/19、入口自检 10/10，来源未知/不可审计；不宣称全层通过、候选提交或上传。

---

## 1. 位置

| 项 | 值 |
|---|---|
| worktree | `/Users/leo/Projects/agos-cursor-fix-20260909` |
| 分支 | `fix/cursor-integration-20260909` |
| **本轮起始提交** | **`745a0a6`** |
| 接收到的 HEAD（起始提交的父） | `cf5ee889da1f481323e7e3ecd9bea188d3ad647b` + 10 个未提交修改 |
| 最终源码提交 | `<待冻结后填写——功能改动的最后一跳>` |
| 交付 | 该分支尖端 |
| 状态 | `<待——是否 push / 合并 main / 部署 / 重启用户 DSH>` |

`745a0a6` 把第三轮已验收的 10 个未提交修改落成提交，**内容零改动**。
它存在的唯一目的是给本轮一个可引用的起点——第三轮的交付是"分支尖端 + 10 个未提交修改"，
那个形态无法被后续引用。

**基线核对已完成且三重通过**（HEAD 一致 / `git diff` 快照逐字符相同 / 596 个 tracked 文件
逐文件 sha256 零差异），详见 [VERIFICATION.md §0](VERIFICATION.md)。
即：**本轮起点与第三轮验收当时逐字节相同。**

### 1.1 关于"钉提交 SHA"

沿用第三轮的做法：**正文里不钉交付提交 SHA**——每写一次文档 HEAD 就变一次，钉了必然过期。
钉的是**功能改动的最后一跳**，并注明其后只有文档提交。

---

## 2. 本轮修改了什么

| 归属 | 目标 | 实际改动 | 结论 |
|---|---|---|---|
| A | 真实 swarm 集成 | 入口 + `inspectSwarmExports` / `describeSwarmProvenance` / Fleet XML 差分；合成业务测试保留 | 本地旧 swarm **19/19 运行记录**；来源不可审计、不可传递。干净树 blocked。措辞见 [COVERAGE.md §2.6](COVERAGE.md) |
| B | Linux 隔离入口 | 生产 `verificationSandbox` 复用入口；范围内正控 sentinel | 代码修复已复审；最终实测 **`blocked`**（Darwin，无运行时） |
| C | 宿主联测可移植性 | 浏览器/dsh PATH 解析、`/proc` 身份兜底、场景 5 改 `getSnapshot()`、进程组杀进程覆盖 | 首轮 host **9/9**；host unit **117/117**；最终核对 311 个非 Markdown frontend 文件未变 |
| D | 验证矩阵与证据 | `run-matrix.mjs` 四层编排；66 项负控；15 条削弱 | 只要求 code-gate 时可选层 blocked **不**报产品失败（退 0）；`--require=swarm,linux` 退 **78** |
| 主控 | 参数守卫 / PID 心跳 / swarm 目录归一 / 正式门接线 | 见 [REVIEW.md](REVIEW.md) | 已落地；最终 code-gate 1263/0/5 |
| E | 文档与交付 | 本目录四份文档 + 两份 README 的时效性修正 | 见 [§7](#7-交付物清单) |

**唯一已定论的产品行为变化**是主控那条：
`node scripts/acceptance/measure-dependency-surface.mjs` 现在**拒绝未知参数**（exit 78）。
合法参数只有 `--out=` `--plugin=` `--logdir=` `--no-shield`。
若你的脚本或笔记里有别的标志，它现在会**明确失败**而不是被吞掉——这是有意的，缘由见下 [§4.1](#41-measure-dependency-surface-现在会拒绝未知参数)。

---

## 3. 怎么复跑

```bash
cd /Users/leo/Projects/agos-cursor-fix-20260909

# 正式门（权威口径；现含 acceptance-unit / integration-unit / linux-layer-unit）
node scripts/acceptance/run-acceptance.mjs --with-frontend --json=<logdir>/acceptance.json --logdir=<logdir>/acceptance
#   最终 code-gate 1263/0/5，12 gate 全过，authoritative=true。

# 验收器自测
node --test scripts/acceptance/selftest.mjs

# 负控的元证明：把验收器改坏，看负控抓不抓得到
zsh scripts/acceptance/mutation-check.sh
node scripts/acceptance/test/mutation-counter-evidence.mjs

# 真实宿主浏览器联测（需要系统里已装 Chrome / Chromium）
node frontend/tests/host-integration/run.mjs --logdir=<logdir>
#   首轮：9 passed / 0 failed / 0 blocked / 0 skipped，exit 0（仅 darwin）；host unit 117/117

# 本轮新增：集成矩阵
node scripts/acceptance/integration/run-matrix.mjs --require=code-gate --logdir=<logdir> --json=<logdir>/matrix.json
#   可选层缺席 ≠ 产品失败。显式要求的层 blocked → 退 78。
#   `--require` 仍会跑有入口的其他层。只要 swarm+linux、别的不跑: --only=swarm,linux
# 真实 swarm（指向包目录或 lib/index.js 均可）
AGOS_SWARM_MODULE=/path/to/dsh-kimicode-swarm node scripts/acceptance/integration/swarm/run.mjs --logdir=<logdir>
# Linux 隔离（本机必 blocked）
node scripts/acceptance/integration/linux/run-linux-isolation.mjs --logdir=<logdir>
```

### 3.1 干净依赖树复现

```bash
CLEAN=$(mktemp -d) && cp plugins/package.json plugins/package-lock.json "$CLEAN/"
cd "$CLEAN" && npm ci        # 期望 <待填>，不得用 --force / --legacy-peer-deps
npm ls --depth=0             # 期望 <待填>
```

---

## 4. 会绊到你的事

### 4.1 `measure-dependency-surface` 现在会拒绝未知参数

**这是本轮唯一一个会改变你肌肉记忆的变化，所以放第一条。**

```sh
node scripts/acceptance/measure-dependency-surface.mjs --print
# ❌ 无法识别的参数:--print
# exit 78
```

**为什么加这个**：该脚本的**默认输出路径就是 tracked 的**
`scripts/acceptance/dependency-surface.json`，而旧的参数解析（`args.find(a => a.startsWith('--name='))`）
会把认不出的标志**一声不响地吞掉**。本轮主控真的踩了这一脚：想只读打印，
实际跑完 6.5 分钟全量测量并**覆写了版本控制里的基线**（471 增 / 338 删）。
完整复现见 [REVIEW.md §0](REVIEW.md)。

**你现在该怎么做：**

| 想干的事 | 正确命令 |
|---|---|
| 只想看当前基线内容 | 直接读文件，别跑脚本 |
| 想测量但**不动**基线 | `--out=<临时路径>`（**注意有等号**） |
| 只测一个插件 | `--plugin=<名>` |
| 确实要重算 tracked 基线 | 不带 `--out=` 直接跑，并且**确认此刻没有别人在改源码** |

最后一条不是客套。本轮那次误测量除了覆写基线，产出的数据**本身也不可信**——
当时四个代理正在改源码，它观测的是移动靶。**依赖面测量必须在冻结态跑。**

⚠️ 裸 `--out`（`--out /tmp/x`，无等号）**同样 exit 78**。这个形态最阴：
旧代码里 `--out` 和 `/tmp/x` 两个都落空，于是静默回落到覆写仓库基线——
操作者以为自己把输出重定向走了。负控 NC21b 专钉这一条。

### 4.2 Linux 层是 `blocked`，而且本轮解不开

本机是 `Darwin 25.5.0 arm64`，`bwrap` / `unshare` 是 **Linux 内核特性的用户态入口**，
不可能出现在 macOS 上；docker / podman / lima / colima / orbstack / vagrant / multipass /
qemu **及对应 .app 全部不存在**，`brew` 里也没有任何容器/虚拟化 formula。

**不装的理由是执行约束**，不是懒：本轮禁止"安装系统服务"，而容器/VM 运行时都需要
守护进程或内核扩展，也装不进临时目录。

`blocked` **不等于** `pass`，也**不等于**产品代码有缺陷——它只说明这台机器上验不了。
恢复条件（三选一）与逐项探测证据见 [COVERAGE.md §3](COVERAGE.md)。

默认入口 **exit 0**（要 exit 2 需 `--strict-blocked`）。swarm 干净树 blocked 则 **exit 2**。
所以 `node run-linux-isolation.mjs && echo 过` 在本机会打印「过」——看 `verdict`，别看退出码。

### 4.3 真实 swarm 模块：**是生产在跑的那份字节，但来源不可审计**

这一条要**同时记住两半**，只记一半都会得出错误结论。

**一半：来源查不到。**
`/Users/leo/Projects/agos-round2-20260908/plugins/node_modules/dsh-kimicode-swarm`

- 与 registry `0.1.0` **同版本号、完全不同内容**（181 KB vs 63 KB）；
- registry 三个版本**都不含** `runNormalizedBatch`；
- 其声明上游仓库的**全部历史**里都搜不到这个符号；
- 产物无 `_resolved` / `_integrity` / `gitHead` / build 痕迹。

→ **版本号在这里不是可用的来源标识**，照着 `0.1.0` 去 npm 装会拿到一个不同的包。

**另一半：它恰恰是生产在跑的那份。**
只读比对（只算 sha256，没动 live profile）显示 **5 个宿主位置**
（`~/.dsh/profiles/{desktop,web,headless}` 下的 `kimicode-swarm-aligned` 与
`node_modules/dsh-kimicode-swarm`）**全部命中同一哈希** `0a912120a3072816…`，
与本轮实跑所用字节逐字节相同。

所以三个维度要分开说：**对生产行为的代表性高**、**来源可审计性无**、**第三方可复现性无**。

**允许的措辞**："用真实宿主上正在运行的那一份字节实跑了 `runNormalizedBatch`；
该字节来源不可审计，第三方无法独立复现"。
**不允许**："真实 swarm 集成已验证通过"（复审者拿不到同一份字节）；
**也不要**贬成"用了个来源不明的模块"（低估了代表性）。

💡 **对你有用的一条**：该产物 `dependencies: {}`，**不含** dsh-settings——
这正是"对齐构建"的含义。所以用 `AGOS_SWARM_MODULE` 指向它做验证
**不会**把第二轮那个依赖冲突重新引入。这是"别把 swarm 加回 `plugins/package.json`"的
**正确替代路径**。

详见 [COVERAGE.md §2](COVERAGE.md)。

### 4.4 第三轮的三个坑仍然有效

原文见第三轮 [HANDOFF.md](../agos-fix-20260909/HANDOFF.md)，这里只提醒别踩回去：

1. **联测需要隔离的 Playwright，它会拒绝借用 `~/.dsh` profile。** 这是有意的。
   解析顺序：`AGOS_PLAYWRIGHT_MODULE` → 本仓依赖树 → 大声 `blocked`。
2. **改了 `plugins/**` 之后依赖面产物会自报陈旧**（按**内容指纹**判，不是按 `gitHead`）。
   这是提醒不是错误；权威判定在 `host-modules-check` 那一闸。`NC20f` 钉住了这一点，别改回去。
3. **`dsh-kimicode-swarm` 不在依赖树里是设计**，在 `host-integrations.json` 里逐条声明。
   **不要**为了消 skip 把它加回 `plugins/package.json`——那会把 `dsh-settings` 拽回 rc.6，
   整棵树重新装不出来，这是第二轮的坑。

---

## 5. 硬规矩（沿用，别破）

- 计数下限**只能从全绿运行生成**，**只上调不下调**。
  ⚠️ 必须写成 `--write-floors=<path>`：**裸标志会 exit 78**（负控 NC19c）。
- 合成运行（用了 `--plan` / `--required-plugins` / `--plugins-root` / `--selftest-file` /
  `--surface` / `--host-integrations`）自报 `authoritative=false` 且**拒绝写基线**。
- **`skip` 永不并入 `pass`**；`blocked` **永不**被汇总成"整体集成通过"。
- **私有语料不为过门去读**，**也不以人工样本冒充**。相关 skip 如实留着。
- 日志哈希**必须实际计算**，禁止手填或猜测。
- 交付日志经过**一次**路径前缀替换（`<HOME>` / `<REPO>` / `<TMP>`），口径写在每份文件头部三行；
  `SHA256.txt` 里的摘要是**脱敏后**文件本身的。**不要"隐改日志又沿用旧 hash"。**
- **保留继承的 `HOME` / `CODEX_HOME`**，连显式设回原值也不做。隔离靠 `mkdtemp` 与
  任务专用 `DSH_HOME` 等参数。

---

## 6. 下一轮建议先做的

1. **横扫所有 CLI 脚本的参数解析。** 同型缺陷（对无法识别的输入保持沉默，
   然后做一件与操作者意图不同的破坏性事）**两轮内出现两次**：第三轮的裸 `--write-floors`、
   本轮的 `--print`。判据很清楚：**默认输出路径是 tracked 文件的脚本排最前**。
   建议做**共享参数解析器 + 一条通用负控**——各修各的正是它反复出现的原因。
   已知同族：`verify-host-tree.mjs --write`、`prepare-host-modules.mjs`。
2. **Linux 上验一遍**（第三轮就提了，本轮仍 `blocked`）。B 的入口已就位，
   只要用户给出授权或环境即可直接跑。bubblewrap 路径的两个运行时探针
   （exit 93 绑宿主 sentinel 可读 / exit 94 loopback 可达）**至今未在真 Linux 上确认过**。
3. **swarm 来源问题需要用户侧决策**：要么拿到可复现的构建来源，
   要么接受"这一层永远不可被第三方复现"并在文档里长期标注。
   这不是实施代理能解决的。
4. `<待补充：A/B/C/D 各自提出的下一轮建议>`

---

## 7. 交付物清单

```
docs/engineering/agos-round4-20260909/
├── TASKS.md          主控写定的任务表：基线、分工与文件所有权、结果格式契约、执行约束
├── COVERAGE.md       覆盖矩阵：平台与模块覆盖、blocked 原因与恢复条件、范围约束
├── VERIFICATION.md   实际命令、退出码、分项计数、证据路径与哈希
├── REVIEW.md         发现 → 最小复现 → 修复 → 关闭依据（否证）
├── HANDOFF.md        本文件
├── LUNA-FIXES-20260910.md  八项修复、三项边界与最终状态
└── logs/             <待主控建立>
```

`logs/` 需要收纳（详见 [VERIFICATION.md §10](VERIFICATION.md)）：

- ✅ `controller-swarm-provenance.md` 与 `controller-linux-capability-probe.md`——**已在位**；
- 误测量产物（471 增 / 338 删 的那份）作为 [REVIEW.md §0](REVIEW.md) 的留证；
- 正式门 / selftest / 联测 / 集成矩阵各层的原始日志；
- `SHA256.txt`（摘要针对**脱敏后**的文件本身）。

**本轮尚未宣布验收通过。** 结论待 A/B/C/D 实跑结果与 R1 / R2 / V 的独立复审。

---

## 8. 待填标记索引

| # | 位置 | 待填内容 | 依赖谁 |
|---|---|---|---|
| H-1 | [§1](#1-位置) | 最终源码提交、交付状态（push / 合并 / 部署 / 重启） | 主控（冻结后） |
| H-2 | [§2](#2-本轮修改了什么) | A / B / C / D 的实际改动与结论 | A / B / C / D |
| H-3 | [§3](#3-怎么复跑) | 四条复跑命令的期望结果 | 主控（冻结后） |
| H-4 | [§3](#3-怎么复跑) | 集成矩阵入口的用法与期望输出 | D |
| H-5 | [§3.1](#31-干净依赖树复现) | `npm ci` 与 `npm ls` 的期望结果 | 主控（冻结后） |
| H-6 | [§6](#6-下一轮建议先做的) | A/B/C/D 各自的下一轮建议 | A / B / C / D |
| H-7 | [§7](#7-交付物清单) | `logs/` 的实际内容清单 | 主控 |
