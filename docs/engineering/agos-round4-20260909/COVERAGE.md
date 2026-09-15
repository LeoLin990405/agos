# 覆盖矩阵（第四轮，2026-09-09）

本文件只回答三个问题：**本轮真的验证过哪些平台与模块**、**哪些是 `blocked` 及其具体原因**、
**要怎样才能解除 `blocked`**。

写作纪律（本轮硬规矩，来自 [TASKS.md](TASKS.md) 的结果格式契约）：

- `blocked` **绝不**被汇总成"整体集成通过"；
- 缺少可选层**不**报成产品代码失败——**代码结果**与**集成覆盖状态**分开报；
- 没有实测的位置一律留 `<待 …>` 标记。**本文件里的每个数字都必须能指到一条命令或一份日志**；
  指不到的就不写。

> 待填标记全表见 [§7](#7-待填标记索引)。用 `rg -n '<待' COVERAGE.md` 可以一次列全。

---

## 0. 状态一览

| 集成层 | 归属 | verdict | 覆盖到什么 | 依据 |
|---|---|---|---|---|
| `swarm` | A | **受限运行记录（不可传递）** | 本地旧 swarm 19 条集成检查；入口自检分开记账 | 产物来源不可审计；不得简称为“swarm 层 pass”，措辞上限见 [§2.6](#26-本轮允许的措辞硬约束) |
| `linux` | B | **`blocked`** | 无——本机为 Darwin，无 Linux 运行时；最终矩阵 exit 78 | [§3](#3-平台覆盖linux-隔离本轮-blocked) |
| `host-browser` | C | **`pass`（darwin）** | 首轮 9 场景 9 pass、host unit 117 pass；Linux 未跑 | final 证据根；311 个非 Markdown frontend 文件首轮至最终哈希未变 |
| `code-gate` | D / 正式门 | **最终通过**（V 独立跑仍红） | 最终：1263 / 0 / 5，exit 0，12 gate 全过，`authoritative: true`。V 未改代码时 1246 / 1 fail（farm EPIPE） | final acceptance SHA256 `311c0c3adde83fb9a479fa5c68f3bff19598d104970293483b4235e5cbd2cfea` |

`linux` 一层的 `blocked` 是**本轮已定论**的：探测在开工时由主控独立执行，
结论与恢复条件见 [§3](#3-平台覆盖linux-隔离本轮-blocked)。

### 0.1 必须写进覆盖记录的基线更正

继承记录里的宿主联测「9/9」**在本轮开工时没有复现**。C 保留的原始日志
`frontend/tests/host-integration/artifacts/round4-c/02-scenarios-prechange/run.log:126`
为 `8 passed, 1 failed`（exit 1）。红的是场景 5：
`the drop is visible in the store's own snapshot: ["online"]`。
根因是断言依赖页内 5ms `setInterval`，Chrome 把后台页定时器节流约 14 倍
（C 实测 71ms 只跳 1 次）。单跑该场景能绿，跑全量套件才红。
这是时序依赖缺陷，不是偶发抖动，也不是历史记录造假。
C 改为断言订阅回调里的 `getSnapshot()`（online→down 跃迁）；5ms 轮询降为「通道还活着」
（`ticks >= 1`），**不再要求它看见 down**。这是抗 flake 的判据替换，不是加严——
改前失败的正是轮询那一闸，订阅通道当时已经绿了。主控独立复跑 9/9。

---

## 1. 平台覆盖

| 平台 | 本轮状态 | 说明 |
|---|---|---|
| `darwin 25.5.0 arm64` | 实跑 | 本轮全部执行都在这台机器上。中途实测 Node `v26.7.0`（冻结门未跑，以冻结日志为准） |
| Linux（任意发行版） | **`blocked`** | 本机不存在任何 Linux 运行时，见 [§3](#3-平台覆盖linux-隔离本轮-blocked) |
| Windows | 未纳入本轮范围 | 本轮任务书未要求，**不宣称**任何 Windows 结论 |

宿主联测所用的浏览器与 Playwright 来源（主控独立复跑 `host2` 日志，**非** live profile）：

- Playwright：`frontend/node_modules/playwright-core` **1.62.1**
- Chrome：`/Applications/Google Chrome.app` **152.0.7977.82**（Mach-O，从不下载）
- dsh：`~/.npm-global/bin/dsh`（source `installed`）
- 进程身份后端：`ps`

---

## 2. 模块覆盖：真实 swarm（**是生产在跑的那份字节**，但来源不可审计）

> 完整审计报告：主控独立执行，原文
> [`logs/controller-swarm-provenance.md`](logs/controller-swarm-provenance.md)。

**结论分三个维度，必须分开说，合并任何两个都会得出错误的结论：**

| 维度 | 判定 | 含义 |
|---|---|---|
| 对生产行为的**代表性** | **高** | 与本机 DSH 实际加载的字节**逐字节相同**（[§2.3](#23-证据四这份字节就是真实宿主上实际运行的那份)） |
| **来源**可审计性 | **无** | 没有任何已发布源能产出这份字节 |
| **第三方**可复现性 | **无** | 复审者若没有这台宿主，拿不到同一份字节 |

这一节决定了本轮 swarm 层结论的**措辞上限**。无论 A 跑出什么，都不能写成
"真实 swarm 集成已验证通过"——**但也不要贬低成"用了个来源不明的东西"**，
那同样不准确，见 [§2.3](#23-证据四这份字节就是真实宿主上实际运行的那份)。

### 2.1 被审计的产物

| 项 | 值 |
|---|---|
| 路径 | `/Users/leo/Projects/agos-round2-20260908/plugins/node_modules/dsh-kimicode-swarm` |
| 自称版本 | `0.1.0` |
| `lib/index.js` 字节数 | 180,923 |
| `lib/index.js` sha256 | `0a912120a30728164b5d8155544468dc9ca13f70a22d3210ffd15af4af547b71` |
| 声明上游 | `git+https://github.com/hongyue0721/dsh-kimicode-swarm.git` |
| `dependencies` | `{}`（裸导入只有 `dsh-tools` / `dsh-llm`） |

主控实测 `await import()` 成功（42 ms）；`runNormalizedBatch`（3 形参）、`publishProgress`、
`SwarmScheduler`、`PROGRESS`、`STOPPED`、XML 四函数均为可用导出。
**它是真实模块（约 3,800 行可运行代码），不是 synthetic 桩。**

### 2.2 三条证据：为什么说来源不可审计

**证据一 —— registry 上不存在这个东西。** 逐版 `npm pack` 解包比对：

| 版本 | `lib/index.js` 字节 | 含 `runNormalizedBatch` |
|---|---:|---|
| registry 0.1.0 | 63,448 | **无** |
| registry 0.1.1 | 66,183 | **无** |
| registry 0.1.2 | 69,980 | **无** |
| **本地产物 0.1.0** | **180,923** | **有** |

本地产物与 registry `0.1.0` **同版本号、完全不同内容**（181 KB vs 63 KB）。
→ **版本号在这里不是可用的来源标识**：照着 `0.1.0` 去 npm 装，拿到的是一个不含所需符号的不同包。

**证据二 —— 上游公开仓库的全部历史里都没有这个符号。**
仓库公开可达，只读浅克隆 60 个提交后实测：

- `rg -l runNormalizedBatch .` → **0 个文件**；
- `git log --all -S'runNormalizedBatch'` → **0 个提交**；
- 对照组：搜 `swarm` 命中 12/12 个文件 → **搜索本身有效**，不是工具用错；
- 上游 `src/` 共 **12 文件 / 1,566 行**，比本地产物的单个输出文件（181 KB）还小一个量级；
- `lib/` 在上游是**未提交的构建产物**（`git log -- lib/index.js` = 0 个提交），
  所以也无法用产物哈希钉到某个 commit。

→ **本地产物不是该仓库任何状态的构建结果。**

**证据三 —— 产物自身没有任何构建溯源标记。**
无 `_resolved` / `_integrity` / `_from`（→ 不是 npm 从 registry 装的）、无 `gitHead`、
`lib/index.js` 内无 commit / buildStamp / `__BUILD` 痕迹。

### 2.3 证据四：这份字节**就是真实宿主上实际运行的那份**

前三条证据说的都是"来源查不到"。第四条说的是另一件事，方向相反，**必须一起读**。

主控做了一次**只读比对**（仅计算 sha256，**没有**复制、**没有**修改任何 live profile 文件；
本轮实跑用的是 round2 worktree 里的副本，**不是** live profile）：

| 位置 | version | sha256(前 16) |
|---|---|---|
| 本轮实跑所用（round2 worktree） | 0.1.0 | `0a912120a3072816` |
| `~/.dsh/profiles/desktop/plugins/kimicode-swarm-aligned` | 0.1.0 | `0a912120a3072816` |
| `~/.dsh/profiles/web/plugins/kimicode-swarm-aligned` | 0.1.0 | `0a912120a3072816` |
| `~/.dsh/profiles/desktop/node_modules/dsh-kimicode-swarm` | 0.1.0 | `0a912120a3072816` |
| `~/.dsh/profiles/headless/node_modules/dsh-kimicode-swarm` | 0.1.0 | `0a912120a3072816` |
| `~/.dsh/profiles/web/node_modules/dsh-kimicode-swarm` | 0.1.0 | `0a912120a3072816` |

**5 个宿主位置全部命中同一哈希**，与本轮实跑所用的字节完全一致。

这把结论的性质**改善了一档**：不是"用了一份来源不明的模块"，而是
**"用了真实宿主上正在运行的那一份字节"**。

对生产行为的**代表性因此是高的**——这比"随便找了个能跑的 swarm"强得多。
但它**不改善**另外两个维度：来源仍然查不到，复审者仍然拿不到同一份字节。

### 2.4 与第三轮记录互相印证

`scripts/acceptance/host-integrations.json` 里第三轮写的 `why` 已记载：

> 真实宿主上能用的是各 profile 下 `plugins/kimicode-swarm-aligned` 的对齐构建产物，
> 该目录只有 `lib/`、无 `src/`、无 `.git`，**补丁不可得**，故不 vendor 进仓。

本次审计**独立印证并加强**了这一条：

- 第三轮说"补丁不可得"；本次进一步确认**连上游源码里都不存在这个符号**——
  不是"补丁拿不到"，而是**任何已发布源都产不出这份字节**；
- 第三轮记载 registry 版本会 `import { installSettingsSection } from '@deepseek-ai/dsh-settings'`，
  把 settings 拖回 `0.1.0-rc.6`，与其余包 `^0.1.2-rc.1` 冲突（第二轮 `npm ci` 装不出可用树的根因）。
  本次实测本地产物 `dependencies: {}`，裸导入只有 `dsh-tools` / `dsh-llm`，**没有** dsh-settings。
  这正是"对齐构建"的含义：**被改造成不再依赖旧 settings API**。

  → **实践结论**：用 `AGOS_SWARM_MODULE` 指向它做验证**不会**把依赖冲突重新引入。
  这是"不要把 swarm 加回 `plugins/package.json`"那条禁令的**正确替代路径**。

### 2.5 判定汇总

| 项 | 判定 |
|---|---|
| 是真实模块吗 | **是**。约 3,800 行可运行代码，`runNormalizedBatch` 真实可调用 |
| 是生产在跑的那份吗 | **是**。5 个宿主位置逐字节相同 |
| 来源可审计吗 | **否**。对不上 registry 任何版本，也对不上其声明上游的任何提交 |
| 第三方能复现吗 | **不能**。没有任何已发布源能产出这份字节 |
| 版本号可信吗 | **不可信**。`0.1.0` 与一份内容完全不同的已发布包撞号 |

### 2.6 本轮允许的措辞（硬约束）

✅ 可以写：**"用真实宿主上正在运行的那一份字节实跑了 `runNormalizedBatch`；
该字节来源不可审计，第三方无法独立复现"**。

前半句**严格强于**第三轮的 skip（真的跑了真实调度器代码，而且是生产同款）；
后半句是必须跟着的限定。

❌ 不可以写："真实 swarm 集成已验证通过" / "swarm 层 pass" 而不带本节。
理由不是措辞洁癖：**复审者拿不到同一份字节，无法独立复跑**，所以这个 pass **不可传递**。

❌ 也不要反过来写成"用了一份来源不明的模块"——[§2.3](#23-证据四这份字节就是真实宿主上实际运行的那份)
证明它恰恰是生产在跑的那一份，说成"来源不明"会低估这次验证的代表性。

任何引用 swarm 结果的地方都必须带上本节的链接。A 的 `moduleProvenance` 字段里
`origin` 应为 `local-build`，`originNote` 必须指向本节，并**应当**记录
[§2.3](#23-证据四这份字节就是真实宿主上实际运行的那份) 的宿主位置比对结论。

---

## 3. 平台覆盖：Linux 隔离（本轮 `blocked`）

> 完整探测报告：主控独立执行，原文
> [`logs/controller-linux-capability-probe.md`](logs/controller-linux-capability-probe.md)。

**结论：本机不存在任何可用于 Linux 内核隔离验证的运行时；`blocked`，且在本轮执行约束下不可解除。**

### 3.1 为什么必须在 Linux 上验

本机 `uname -srm` = `Darwin 25.5.0 arm64`。`bwrap`（bubblewrap）与 `unshare` 是
**Linux 内核特性的用户态入口**，不是可移植工具，**不可能**在 Darwin 上出现。
所以这不是"没装"，是"这台机器上装不了"。

### 3.2 逐项探测（全部为否）

| 类别 | 探测项 | 结果 |
|---|---|---|
| PATH 可执行 | `docker` / `podman`（及守护进程） | 不存在 / 不可用 |
| PATH 可执行 | `lima` / `limactl` / `colima` | 不存在 |
| PATH 可执行 | `orbctl` / `orb` | 不存在 |
| PATH 可执行 | `vagrant` / `multipass` | 不存在 |
| PATH 可执行 | `qemu-system-x86_64` | 不存在 |
| PATH 可执行 | `bwrap` / `unshare` | 不存在（macOS 本就没有） |
| 应用包 | Docker.app / OrbStack.app / UTM.app / VirtualBox.app / VMware Fusion.app / Parallels Desktop.app / Podman Desktop.app / Rancher Desktop.app / Lima.app / crc.app | **全部不存在** |
| 非 PATH 安装位 | `~/.docker/bin`、`~/.orbstack/bin`、`~/.rd/bin`、`~/.lima`、`/opt/homebrew/bin/lima`、`/usr/local/bin/docker`、`/opt/podman` | **全部不存在** |
| macOS 自带 | `container` CLI | 不存在 |
| 包管理器 | `brew`（已装） | `brew list --formula` 中**无**任何容器/虚拟化 formula |

唯一相关的系统文件是 `/usr/libexec/AppleVirtualPlatformHIDBridge`——HID 桥接 helper，
不是可用的虚拟机运行时。

### 3.3 为什么不装一个

本轮执行约束明确禁止：

- **"不安装系统服务"**——容器 / VM 运行时均需守护进程或内核扩展；
- **"新安装只在本轮新建临时目录或隔离环境进行"**——运行时装不进临时目录；
- **"不要为消除 blocked 修改生产服务器、主机内核策略或现有容器权限"**。

即：把 `blocked` 变成 `pass` 的**唯一本机路径**恰好是被约束禁止的那条。
按契约，这种情况必须如实报 `blocked`，不得降级成 `skip`，更不得并入 `pass`。

### 3.4 为什么没走远端 Linux

理论上可以连一台已有 Linux 主机跑验证。本轮**没有走**，两条理由：

1. 已知的 Linux 主机是**用户的生产设施**（NAS / k3s 节点）。在其上跑内核隔离验证，
   即便只读也属于"动生产服务器"，需要用户显式授权；
2. 更关键：那些主机**是否已装 bubblewrap 未知**。若未装，安装动作本身就违反约束——
   连上去大概率仍然 `blocked`，只是把 `blocked` 的位置往后挪一步。

所以它是**恢复条件**，不是本轮的执行项，交由用户决定。

### 3.5 恢复条件（任一满足即可解除）

1. 一台可用的 Linux 环境（VM / 容器 / 物理机），**内核 ≥ 3.8**（非特权 user namespace 落地版本；B 的能力表以此为准，不是 4.18），
   **已安装 bubblewrap**，且允许非特权 user namespace
   （`/proc/sys/kernel/unprivileged_userns_clone` = 1，或发行版默认允许）；
2. 或用户**显式授权**在某台已有 Linux 主机上执行，并确认其已具备 bubblewrap；
3. 或用户**授权在本机安装**容器 / VM 运行时（本轮约束下不可自行进行）。

满足后的执行入口由 B 交付在 `scripts/acceptance/integration/linux/`，
恢复命令（B 入口自报的 `recoveryCommand` 原文）：

```
node scripts/acceptance/integration/linux/run-linux-isolation.mjs --logdir ./linux-layer-logs
```

---

## 4. 范围约束造成的未覆盖（**不是缺陷，也不打算清零**）

这一节记录的是**主动选择不做**的事。把它们写下来，是为了让复审者能区分
"没想到"和"想到了并且决定不做"。

### 4.1 私有语料的 3 项 skip

第三轮正式门的 5 项 skip 中，**3 项是私有语料**（dsh-agos ×2、frontend ×1；
未指定 `SESSION_MEMORY_CORPUS_DIR`）。

本轮的立场，两条都是硬的：

1. **不为清零而读取私人数据。** 覆盖率不值得拿这个换。
2. **也不以人工样本冒充私人语料验证。** 造一份"看起来像"的样本喂进去、
   把 skip 变成 pass，比留着 skip 更坏——它把"未覆盖"伪装成"已覆盖"，
   而复审者从计数上看不出区别。

恢复覆盖的唯一正当方式：**操作者显式提供完整的真实语料目录**。
在那之前，这 3 项**如实留着**。

本轮 skip 的实际数量为 5，逐项位置沿用正式门记录；skip 永不并入 pass。

### 4.2 NAS 共享记忆同步故障（工作流记录，**不在产品代码里绕过**）

第三轮记录：本地记忆已写入；NAS 来源账本提交**超时 exit 3**；推送脚本 **exit 1**。

定性：这是**协作工作流的基础设施故障**，与 AgOS 产品代码无关。

因此本轮**不**在 AgOS 产品代码中绕过、重试或修补它。理由：
在产品代码里加一条"记忆推送失败也继续"的旁路，等于把一个外部基础设施问题
永久编码进产品，而且会让下一次真正的同步故障**更难被发现**。

它留在这里只是为了**如实记录**：本轮的记忆写入链路状态为
`<待本轮结束时的实际记忆推送结果>`。

---

## 5. 恢复条件汇总

| 未覆盖项 | 当前状态 | 恢复条件 | 谁能解除 |
|---|---|---|---|
| Linux 内核隔离 | `blocked` | Linux + 内核 ≥ 3.8 + bubblewrap + 允许非特权 userns；或授权用已有 Linux 主机；或授权本机装运行时 | **用户**（需显式授权） |
| swarm 来源可审计性 | 不可审计 | 拿到可复现的构建来源：能对上 registry 某版本，或能对上上游某 commit 的构建产物 | 模块提供方 / 用户 |
| 私有语料 3 项 skip | 主动不做 | 操作者显式提供完整真实语料目录 | **用户**（涉及私人数据） |
| NAS 记忆同步 | 故障 | 修复 NAS 侧同步链路（工作流范畴，不改产品代码） | 用户 / 运维 |

**注意**：上表四项**没有一项**能由实施代理在本轮约束内自行解除。
把它们列在一起，是为了让"本轮为什么不是全绿"这个问题有一个可核对的答案。

---

## 6. 代码结果与集成覆盖的分开报告

契约硬规则第 2 条要求两者分开。本轮的结论应当这样读：

| 维度 | 本轮结论 |
|---|---|
| **产品代码闸** | **最终通过**：1263 pass / 0 fail / 5 skip，12 gate 全过，`authoritative: true` |
| **集成覆盖** | swarm **受限运行记录（19/19，来源不可审计）**、linux **`blocked`**、host-browser **pass（仅 darwin）**；矩阵 `allVerified=false` |

"代码闸绿" **不蕴含** "集成覆盖完整"。反过来，"linux 层 blocked"
**也不蕴含**"产品代码有缺陷"——它只说明这台机器上验不了。

---

## 7. 待填标记索引

| # | 位置 | 待填内容 | 依赖谁 |
|---|---|---|---|
| C-1 | [§0](#0-状态一览) | swarm 层 verdict / 覆盖内容 / 结果 JSON 路径与哈希 | A |
| C-2 | [§0](#0-状态一览) | host-browser 层 verdict / 覆盖内容 / 结果 JSON 路径与哈希 | C |
| C-3 | [§0](#0-状态一览) | code-gate 层 verdict / 覆盖内容 / 结果 JSON 路径与哈希 | D |
| C-4 | [§1](#1-平台覆盖) | 最终冻结运行的 Node 版本 | 主控 |
| C-5 | [§1](#1-平台覆盖) | 实际解析到的 Playwright 模块路径与浏览器可执行文件 | C |
| C-6 | [§3.5](#35-恢复条件任一满足即可解除) | B 交付的 `recoveryCommand` 原文 | B |
| C-7 | [§4.1](#41-私有语料的-3-项-skip) | 最终冻结门的 skip 逐项点名 | 主控 |
| C-8 | [§4.2](#42-nas-共享记忆同步故障工作流记录不在产品代码里绕过) | 本轮记忆推送的实际结果 | 主控 |
| C-9 | [§6](#6-代码结果与集成覆盖的分开报告) | 最终冻结门的退出码与分项计数 | 主控 |

---

## 8. 需要主控补充的材料

1. ~~两份探测报告需从 `/tmp` 复制进本轮 `logs/`~~ —— **已完成**。主控已落到
   `logs/controller-swarm-provenance.md` 与 `logs/controller-linux-capability-probe.md`，
   经 `diff` 确认与 `/tmp` 原文**逐字节相同**，本文件的引用已改为相对路径。
   仍需补：这两份的**脱敏口径**与 `SHA256.txt` 条目。
2. swarm 产物 `lib/index.js` 的**完整** sha256。本文件目前写到前 16 位
   `0a912120a3072816…`——这是审计报告里出现过的最长形式，**不是**我截断的。
   若要在交付文档里给出全 64 位，需要主控提供。
3. A/B/C/D 各自的 `<layer>.json` 实际落盘路径，以及其中 `logs[].sha256` 的实测值。
