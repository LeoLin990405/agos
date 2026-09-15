# 宿主依赖调查 — 上一轮验收为什么不可复现

主控单写。这一节是本轮 A 包的前置事实基础，也是本轮最重的一条发现。所有结论都由实测得出，单变量替换逐层确认，未据字段名推断。

## 结论摘要

上一轮 833/0/3 的绿色结果**依赖两个只存在于这台工作站的产物**，换任何一台干净机器都无法复现：

1. `@deepseek-ai/dsh-settings` 在 desktop profile 里是一条**指向 DSH Desktop 应用包内部**的软链：
   `~/.dsh/profiles/desktop/node_modules/@deepseek-ai/dsh-settings` → `/Applications/DSH Desktop.app/Contents/Resources/app.asar.unpacked/node_modules/@deepseek-ai/dsh-settings`，版本 `0.1.0-rc.6`。
2. `dsh-kimicode-swarm` 在 desktop profile 里是一条**指向本机手工构建目录**的软链：
   `~/.dsh/profiles/desktop/node_modules/dsh-kimicode-swarm` → `~/.dsh/profiles/desktop/plugins/kimicode-swarm-aligned`，自称版本 `0.1.0`，但**内容与 registry 上发布的 `0.1.0` 不同**。

`scripts/dev-links.sh` 把 `plugins/node_modules` 软链到 desktop profile，于是上一轮的插件套件实际是对着这两个本机产物跑的，**不是对着 `frontend/UPSTREAM.pin` 声明的 0.1.2-rc.1 宿主线**。

## 逐层单变量确认

基线：纯净 `git worktree` 检出 `7e7e359`（`/tmp/agos-baseline-7e7e359`），零 `node_modules`。

| 步骤 | 配置 | dsh-fleet | cn-capabilities | 观察到的报错 |
|---|---|---:|---:|---|
| 0 | 无任何 node_modules | 106/8 fail（仅 114 个测试被收集） | 57/3 fail（仅 60 个） | `Cannot find package '@deepseek-ai/schemastery'` |
| 1 | registry 精确 pin 全量装齐 | 106/8 fail | 78/4 fail | `'@deepseek-ai/dsh-settings' does not provide an export named 'installSettingsSection'` |
| 2 | 步骤 1 + `dsh-settings` 换成 desktop 的 `0.1.0-rc.6` | 106/8 fail | 77/5 fail | `'dsh-kimicode-swarm' does not provide an export named 'escapeXml'` |
| 3 | 步骤 2 + `dsh-kimicode-swarm` 换成 desktop 的本地构建 | **137/137 pass** | **82/82 pass** | 无 |

步骤 3 与上一轮记录的 137/137、82/82 完全一致，确认根因链条闭合、无残余变量。

## 内容漂移的直接证据

同一个版本号，registry 与本机副本内容不同：

| 包 | 来源 | 版本号 | `lib/index.js` sha256 前 20 位 | `lib/` 文件数 | 关键导出 |
|---|---|---|---|---:|---|
| `dsh-kimicode-swarm` | npm registry | 0.1.0 | `585c9ea3bd684b5f9c29` | 4 | 无 `escapeXml` |
| `dsh-kimicode-swarm` | desktop 本机构建 | 0.1.0 | `0a912120a30728164b5d` | 6 | 有 `escapeXml` |

反过来，`dsh-settings@0.1.2-rc.1` 的 registry 副本与用户 web profile 副本**字节一致**（`lib/index.js` sha256 均以 `bb4bee8b1772c59b` 开头），两者都**不导出** `installSettingsSection`。所以这一条不是漂移，是真实的 API 移除。

## 公网可得性实测

| 包 | pin 版本 | registry `latest` tag | pin 版本公网可得 |
|---|---|---|---|
| `@deepseek-ai/schemastery` | 3.18.2 | 3.18.2 | 是 |
| `@deepseek-ai/dsh-agent` | 0.1.2-rc.1 | 0.1.0-rc.6 | 是 |
| `@deepseek-ai/dsh-tools` | 0.1.2-rc.1 | 0.0.1-rc.1 | 是 |
| `@deepseek-ai/dsh-llm` | 0.1.2-rc.1 | 0.0.1-rc.1 | 是 |
| `@deepseek-ai/dsh-commands` | 0.1.2-rc.1 | 0.0.1-rc.1 | 是 |
| `@deepseek-ai/dsh-subagent` | 0.1.2-rc.1 | 0.0.1-rc.1 | 是 |
| `@deepseek-ai/dsh-settings` | 0.1.2-rc.1 | 0.0.1-rc.1 | 是（但缺 `installSettingsSection`） |
| `@deepseek-ai/dsh-session` | 0.1.2-rc.1 | 0.0.1-rc.1 | 是 |
| `@deepseek-ai/dsh-host-webserver` | 0.1.2-rc.1 | 0.0.1-rc.1 | 是 |
| `@openai/codex-sdk` | 0.147.0 | 0.153.4 | 是 |
| `dsh-kimicode-swarm` | 本机 0.1.0 构建 | 0.1.2 | **否**（同版本号内容不同，缺 `escapeXml`） |

registry 的 `latest` tag 普遍停在 0.0.1-rc.1，因此**必须显式钉住整条 peer 链**，否则 npm 会把 `dsh-commands`→`dsh-agent`→`dsh-llm` 逐级拉回旧版并产生 ERESOLVE 级联。

## 本轮采取的方案

`plugins/package.json`（新建，主控所有）+ `plugins/package-lock.json` 构成 profile 层隔离依赖树；`plugins/dsh-mcp-bridge/package.json` 加 `@deepseek-ai/dsh-agent` 构成第二层。分两层是因为 `dsh-kimicode-swarm` 经 `dsh-commands` 声明 peer `dsh-agent@^0.0.1-rc.1`，与 pin 的 `0.1.2-rc.1` 真实冲突；真实宿主也是靠 `~/.dsh/profiles/node_modules` 与 `~/.dsh/profiles/<name>/node_modules` 两层隔开的。**未使用 `--force` 或 `--legacy-peer-deps` 掩盖冲突**，两层 `npm install` 均干净退出。

两个清单无法精确描述的包按「操作者显式提供」处理：从 `~/.dsh/profiles/desktop` 以 `cp -RL` 解引用成实体副本放进隔离树，**不是软链**（`cp -R` 会保留软链并把解析结果指回 `/Applications`，必须 `-L`）。

内容基准由 [`scripts/acceptance/verify-host-tree.mjs`](../../../scripts/acceptance/verify-host-tree.mjs) 产出并校验，基准文件 `scripts/acceptance/host-tree-digests.json`：

| 包 | 磁盘版本 | 文件数 | 树摘要 sha256 | 性质 |
|---|---|---:|---|---|
| `dsh-kimicode-swarm` | 0.1.0 | 34 | `78edb7fbd2f7a526435065c14e3dec7d560926126cd1333c3e40502e3704ea97` | **真·公网不可得**，本机构建 |
| `@deepseek-ai/dsh-settings` | 0.1.0-rc.6 | 10 | `00f521f8ffce429117a9897053e0c75cb68cb06cbcea5e18446ed1f55359c1e5` | 公网**可得**，但清单声明的是另一个版本 |

摘要口径写在脚本顶部（对包内每个文件按相对路径排序，逐行喂 `<相对路径>\0<字节数>\0<该文件 sha256>`，排除嵌套 `node_modules`），覆盖**所有**文件而非只 js/mjs/json —— 换掉一个 `.node` 二进制或 `.d.ts` 同样要被发现。

未向 `~/.dsh/profiles/**` 写入任何内容，未安装到指向用户 profile 的软链，未改动 `HOME`/`CODEX_HOME`。

### 校正记录（2026-09-09，由独立审查者 2 的 P1 触发）

审查者 2 指出：`plugins/package-lock.json` 给这两个包记的是 registry tarball + integrity 哈希，而磁盘上的内容不是 registry 内容，**且没有任何东西会发现这件事** —— 在 `plugins/` 里跑一次 `npm ci` 就会把工作树换成 registry 内容并让套件变红，而锁文件的 integrity 哈希让这棵树看起来像是被验证过的。该发现成立。复核后有三处本文档原先写错，就地改正如下：

1. **`@deepseek-ai/dsh-settings` 不是「本机产物」，是我钉错了版本。** 原先把它列进「不可公网复现」并记来源为 `DSH Desktop.app` 内副本。实测：registry 上存在 `0.1.0-rc.6`，其 `lib/index.js` 与磁盘副本**字节等同**（sha256 均为 `18e5dd394cf88b8d7fa64564b1ef533b94325f7e6cb3d3846d021e850511a0d6`），且含 `installSettingsSection`。所以正确做法本应是钉 `0.1.0-rc.6`，而不是钉 `0.1.2-rc.1` 再从应用包拷贝补救。
   **但它不能简单改声明**：`0.1.0-rc.6` 声明 peer `@deepseek-ai/dsh-invariants@^0.1.0-rc.6`，而树里另外七个包（`dsh-agent`、`dsh-commands`、`dsh-scope`、`dsh-subagent`、`dsh-system-prompt`、`dsh-tools`、`dsh-user-approval`）都要求 `^0.1.2-rc.1`，`npm install` 实测 `ERESOLVE`（已回滚，本轮禁止用 `--force`/`--legacy-peer-deps` 掩盖）。
2. **原记录的两个树摘要 `54f276e3…` / `0ebe1d0a…` 按任何已声明口径都复现不出来**，已作废并换成上表由脚本产出的值。一个复现不出的摘要比没有摘要更糟 —— 它看起来可验证。附带确认：来源目录与安装副本的摘要完全相同，`cp -RL` 是忠实的。
3. **原「尚未解决的风险 3」关于 schemastery 的理由是错的。** 原文称 pin 的 `dsh-settings@0.1.2-rc.1` 声明 peer `^3.18.2`，故各插件声明的 3.18.1 已过时。但真正在树里的 `0.1.0-rc.6` 声明的是 peer `^3.18.1`，所以插件的 3.18.1 与实际树是一致的，A 包 `layers.json` 写 3.18.1 也是对的（审查者 2 报的「两个真源不一致」由此解释：不一致存在，但对的那一侧是 3.18.1）。3.18.2 同时满足 `^3.18.1`，故树在功能上无碍，仅我给出的理由错误。

### 由此浮出的更重要结论：`dsh-fleet` 与 pin 的宿主线不兼容

`dsh-fleet/lib/index.js` 需要 `dsh-kimicode-swarm` 的 `escapeXml`，而 swarm 需要 `dsh-settings` 的 `installSettingsSection`；该导出只存在于 `0.1.0-rc.6` 及更早，而 `0.1.0-rc.6` 的 peer 属于 rc.6 线，与 pin 的 0.1.2-rc.1 线冲突。也就是说 **`dsh-fleet` 按现在的写法无法在 `frontend/UPSTREAM.pin` 声明的宿主线上安装成立**，它需要 rc.6 线；desktop profile 能跑正是因为它整体停在 rc.6（与契约研究者独立得出的「desktop profile 停在 rc.6 线」一致）。这比「某个导出缺失」严重一级：不是补一个导出能解决的，而是版本线选择问题。本轮记录为发现项，未修 —— 修它要么改 `dsh-fleet` 不再依赖那条链，要么把 pin 移到 rc.6，两者都超出本轮范围且后者需要先审计。

## 尚未解决的风险

1. **`dsh-kimicode-swarm` 仍不可公网复现。** 干净机器复现验收必须由操作者显式提供这个包的路径。这是「摆脱个人 profile 依赖」目标唯一未达成的一项，不能声称已解决。
2. **`dsh-fleet` 在 pin 对应的 web profile 里装不起来。** `lib/index.js` 从 `dsh-kimicode-swarm` import `escapeXml`，而 swarm 依赖 `dsh-settings` 的 `installSettingsSection`；web profile 的 `dsh-settings@0.1.2-rc.1` 已移除该导出。这是与测试无关的真实生产问题，本轮记录为发现项，未修。
3. ~~**各插件 `package.json` 声明的 `@deepseek-ai/schemastery: 3.18.1` 相对 pin 已过时**：pin 的 `dsh-settings@0.1.2-rc.1` 声明 peer `^3.18.2`，真实 web profile 实装 3.18.2。~~ **此条已作废**，理由见上方校正记录第 3 点：真正在树里的 `dsh-settings@0.1.0-rc.6` 声明 peer `^3.18.1`，插件声明是对的。隔离树取 3.18.2（同时满足 `^3.18.1`），功能无碍。

4. `cn-capabilities` 在 swarm 加载失败时给出明确中文错误并继续，`dsh-fleet` 则在 import 期直接抛 `SyntaxError`。两者的失败姿态不一致，`dsh-fleet` 缺少同等的 fail-closed 降级。
5. **`npm ls` 在 `plugins/` 里必然报 `ELSPROBLEMS ... invalid: @deepseek-ai/dsh-settings@0.1.0-rc.6`。** 这是上述钉错版本的既有后果，属于**预期稳态**，所以 `npm ls` 不能被当作本目录的通过/失败门（它永远是红的）。真正的检测器是 `verify-host-tree.mjs`，它校验的是「内容是否等于产出验收结果的那份内容」，与版本号声明无关 —— 反证实测：把 registry 的 `dsh-kimicode-swarm@0.1.0` 换进去，版本号与文件数都不变（同为 `0.1.0`、34 文件），仅摘要不同，脚本正确报红。
