# 依赖可复现性 — 第三轮最终状态（2026-09-09）

本文围绕**最终状态**写。上一轮（`docs/engineering/agos-round2-20260908/DEPENDENCIES.md`）的结论已被本轮取代，历史结论在文末「被取代的历史结论」一节明确标记，不在正文里混用。

## 结论先说

`plugins/` 的宿主依赖树**现在可以由 `npm ci` 从公开 registry 干净复现**。

| 检查 | 命令 | 结果 |
|---|---|---|
| 干净安装 | `cd plugins && rm -rf node_modules && npm ci` | exit 0，31 包 |
| 树一致性 | `cd plugins && npm ls --depth=0` | **exit 0** |
| 非 optional 的 UNMET / invalid | `npm ls --all` 过滤 | **零条**（仅余其他平台的 codex 二进制等 OPTIONAL 项，属正常） |
| mcp-bridge 层 | `cd plugins/dsh-mcp-bridge && npm ci` | exit 0，17 包，`npm ls` exit 0 |

全程**未使用** `--force`，**未使用** `--legacy-peer-deps`，**未移动** `frontend/UPSTREAM.pin`，**未从 live profile 复制任何包**。

依赖声明从 11 个降到 6 个：

```
@deepseek-ai/dsh-llm      0.1.2-rc.1
@deepseek-ai/dsh-timeout  0.1.2-rc.1
@deepseek-ai/dsh-tools    0.1.2-rc.1
@deepseek-ai/schemastery  3.18.1
@openai/codex-sdk         0.147.0
react                     18.3.1
```

⚠️ 这个清单的前一版少了 `@deepseek-ai/dsh-timeout` 与 `react`：我第一遍只匹配静态 `from '...'`，
漏了 `dsh-agos-router/lib/index.js:216`/`:413` 对 `dsh-timeout` 的**动态** import，以及
`dsh-agos/lib/client.js:7`/`dsh-fleet/lib/client.js:7` 的 CommonJS `require('react')`。
`dsh-timeout` 当时靠 `dsh-llm`/`dsh-tools` 的传递依赖才解析到（一次锁刷新就可能消失）。
两者都是完整导入图扫描抓出来的，已补进显式声明。

外加两层结构的第二层（复刻真实宿主的 `node_modules` 分隔）：`plugins/dsh-mcp-bridge/` 自己声明 `@deepseek-ai/dsh-agent@0.1.2-rc.1` 与 `@deepseek-ai/dsh-llm@0.1.2-rc.1`。

## 上一轮为什么不可复现 —— 本轮实测的因果链

上一轮的 `plugins/package.json` 声明了 11 个依赖，而**插件源码实际导入的只有 5 个说明符**。多出来的 6 个（`@deepseek-ai/dsh-settings`、`dsh-commands`、`dsh-host-webserver`、`dsh-session`、`dsh-subagent`、`react`）恰好覆盖 `dsh-kimicode-swarm` 的 peer 清单 —— 它们只为满足 swarm 而存在，AgOS 自己一行都不导入。

顺着 swarm 往下查，四条实测事实（全部本轮取得，不是沿用旧结论）：

1. **registry 版本不导出所需符号。** 对 `dsh-kimicode-swarm@0.1.0 / 0.1.1 / 0.1.2` 逐版 `npm pack` 后检查导出表，三个版本的公开导出都只有 `Config, SWARM_GUIDANCE, SWARM_SETTINGS_NAMESPACE, apply, inject, renderSwarmResults` 六项，**均不含** AgOS 需要的 `publishProgress / parseResultsXml / escapeXml / textOf`，也不含 cn-capabilities 用的调度器 `runNormalizedBatch`。

2. **registry 版本自身把整棵树拖进冲突。** 三个版本的 `lib/index.js` 第 2 行都是
   `import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings"`。
   该导出只存在于 `dsh-settings` 0.1.0-rc.6 及更早。ESM 具名导入缺失是**加载期** SyntaxError（上一轮基线日志 `logs/baseline/dsh-fleet.registry-pin.txt` 记录了这条 `SyntaxError: ... does not provide an export named 'installSettingsSection'`），所以为了让这行 import 能加载，整棵树的 settings 必须降到 rc.6；而 rc.6 的 peer 属另一条线，与其余七个包的 `^0.1.2-rc.1` 冲突。这就是上一轮 `npm ls` 恒报 invalid、`npm ci` 装不出可用树的根因。

3. **上游源码不解决问题。** 上游仓 `github.com/hongyue0721/dsh-kimicode-swarm`（本轮只读浅克隆，HEAD `311d6f42a26070501c87a70eebf628391ce7604c`，version 0.1.2）确实带 `src/`、`tsconfig.build.json`、`tsdown.config.ts`，可构建。但 `src/index.ts:12` **仍然**导入 `installSettingsSection`（`:279` 真实调用它），照它构建只会把第 2 条的冲突原样带回来。

4. **本机那份可用产物没有可审查来源。** 真实宿主上能用的是操作者放在各 profile `plugins/kimicode-swarm-aligned` 下的**对齐构建产物**：它的 import 表里没有 `dsh-settings`（补丁去掉了），导出表比 registry 版多约 30 个符号。但该目录只有 `lib/` 打包产物，**没有 `src/`、没有 `.git`**，补丁本身不可得 —— 既无可审查来源，也无可复现构建。按「确需保留的源码要有可审查来源与可复现构建」的门槛，它不 vendor 进仓。

结论：swarm **不可能**成为可复现的构建期依赖。留着它，依赖树永远绿不了；这不是声明写法问题，是包本身的事实。

## 修法：把 swarm 定性为宿主环境集成

swarm 在真实宿主上**本来就是同级插件**（已核实：`~/.dsh/profiles/desktop` 与 `~/.dsh/profiles/web` 均同时存在 `plugins/kimicode-swarm-aligned` 与 `node_modules/dsh-kimicode-swarm`）。所以它的正确定性是**宿主环境集成**，不是本仓的包依赖。

解析策略集中在一处：`plugins/dsh-agos/lib/swarm-host-integration.mjs`（按仓内既有约定，跨插件共享模块放 `dsh-agos/lib/`，与 `agent-prompts.js`、`input-limits.js` 同列）。

```
resolveSwarmModule() → { available, module, source, reason }
  source='opt-in'  ← AGOS_SWARM_MODULE 指定
  source='sibling' ← 裸说明符解析到同级插件
  available=false  ← reason 可读且**可区分**
```

三条分支的语义边界，逐条都有测试钉住（`plugins/dsh-fleet/test/swarm-compat.test.mjs`）：

- **opt-in 配了却加载不了 → 硬错误**，不静默回落成「本机没装」。否则路径写错会被伪装成环境缺失，操作者永远看不到自己配错了。
- **解析到包但缺导出**（registry 版就是这样）→ reason 与「包不存在」**分得开**。混同会让排障分不清是没装还是版本不对。
- **未配置且解析不到** → 记账式 no-op：不抛错（进度发布不该弄死一个批次），但记下 `droppedCalls` 并给出 reason，调用方落一行日志。**不可用时绝不声称发布成功。**

### 四个符号按真实性质分别处理，不一视同仁

| 符号 | 性质 | 处理 |
|---|---|---|
| `escapeXml` / `unescapeXml` / `textOf` | 纯函数 | 内联到 `plugins/dsh-fleet/lib/fleet-swarm-compat.mjs` |
| `parseResultsXml` | 纯解析器 | 内联。**注意**：Fleet 解析的 XML 是 Fleet **自己**在 `lib/index.js` 的 `renderXml()` 生成的（消费者是同文件的 `presentationMeta`），swarm 只是恰好有个同形状的解析器被顺手复用。内联反而**消除**了契约漂移风险 —— 原先 Fleet 的生成器和 swarm 的解析器可以各自独立演化而没人发现 |
| `publishProgress` | **不是**纯函数，真实跨插件集成 | **不内联**，改运行时可选解析 |

`publishProgress` 为什么不能内联：它写的是 swarm 模块级的 `PROGRESS` Map，由 swarm 自己的 `progressResponse()` 经 `/api/swarm/progress` 路由喂前端。消费方已核实存在：`frontend/src/stores/live.ts:689` 拉 `/api/swarm/progress` 读 `calls`，`:808` 用 `state.progress?.calls`。内联一份实现只会让 Fleet 写进**自己**的 Map，swarm 的路由永远看不到，前端的 Fleet 进度就静默变空 —— 那是把可复现性换成静默功能回归，不划算。

cn-capabilities 的情况同理但更深：`lib/index.js:2066` 调 `swarm.runNormalizedBatch(...)`，用的是 swarm 的**调度器**。它原本就是懒加载（`loadSwarm()`），本轮只是把解析策略换成统一的 `resolveSwarmModule()`，行为边界不变：解析失败只让 `plan_run` 执行阶段报一条可读错误，该插件其余 21 个工具不受影响。

### 内联的忠实性怎么证明

差分测试：同一批输入分别喂给内联版与**真实 swarm** 的实现，断言深相等。覆盖五个实体的转义顺序、属性缺失时的 `undefined` vs `null`、数值属性、body 的 completed/failed 分流、多条 subagent。

- 有真实 swarm 在场时（`AGOS_SWARM_MODULE` 指向一份可用 swarm）：**11/11 通过，exit 0** —— 差分实跑并通过。
- 无对照时如实标 `blocked`，不打桩自证（打桩对照等于自己和自己比，毫无区分力）。

特别钉住一处最容易在「重写一遍」时走样的语义：swarm 原实现在对象字面量里把 `team` / `member` 写了两遍（`task` 内一次、顶层一次），JS 取后者，于是顶层生效的是带 `?? null` 的那份、`task` 内的不带。前端消费的正是这个结构，把重复键「清理」成一份会改变 `undefined` vs `null`，属行为漂移。内联版保留生效语义并在注释写明来由，测试断言 `row.team === null` 且 `row.task.team === undefined`。

### 削弱反证（在 `/tmp` 副本上做，均实测变红）

| 改坏什么 | 结果 |
|---|---|
| `escapeXml` 把 `&` 的替换挪到最后（制造二次转义） | 2 项红（差分 + 显式顺序断言） |
| 顶层 `team` 去掉 `?? null` | 2 项红（差分 + 语义钉住断言） |
| 给可用分支包上 `try/catch` 吞异常 | 1 项红（不吞异常负控） |
| 把 `dsh-kimicode-swarm` 加回 `plugins/package.json` | 1 项红（解耦钉住断言） |

最后一条是防回归的：没有它，下一次「顺手把依赖加回来」会让干净安装静默失效而无人发现。

## 覆盖率代价 —— 如实记账，不掩盖

拆除后，依赖**真实 swarm 调度器**的检查在干净树上无法运行。这是真实的覆盖率下降，按与「三项私有语料 skip」「Linux `verification-unavailable`」同一规格如实报告：

| 套件 | 干净依赖树（交付默认） | `AGOS_SWARM_MODULE` 指向可用 swarm |
|---|---|---|
| `cn-capabilities` | 114 tests / 110 pass / 0 fail / **4 skipped(blocked)** / exit 0 | 114 / **114** / 0 / 0 / exit 0 |
| `dsh-fleet` 的 `swarm-compat.test.mjs` | 11 / 10 / 0 / **1 skipped(blocked)** / exit 0 | 11 / **11** / 0 / 0 / exit 0 |

那 4 项是 `plugins/cn-capabilities/test/plan-run.fake.test.mjs` 里的 A4 系检查，立意是**真调度器**的分波行为（见该文件第 2 行），打桩替代就不再是这条检查，所以标 blocked 而非改成桩测试。skip 原因里点名了 `AGOS_SWARM_MODULE` 与恢复方式，不是一句「skipped」了事：

```
未覆盖(blocked):本检查需要真实 swarm 调度器,当前不可用。未解析到同级 swarm 插件
(dsh-kimicode-swarm):Cannot find package ... swarm 是宿主环境集成而非本仓依赖,
干净依赖树里本就没有它;要在本机启用请设 AGOS_SWARM_MODULE 指向一份可用的 swarm 模块。
设 AGOS_SWARM_MODULE 指向一份可用 swarm 即可恢复覆盖。
```

**注意 `--floors` 计数下限的联动**：这 4 项从 pass 变 skipped 会让 `minPass` 下限失效。基线更新必须带这条理由，不能静默下调（正式门的「全部 skip 必须失败」与「计数下降必须失败」两条规则仍然生效）。

## schemastery 从 3.18.2 回到 3.18.1

上一轮取 3.18.2 的唯一理由是 `@deepseek-ai/dsh-settings@0.1.2-rc.1` 声明 peer `^3.18.2`。该依赖本轮已拆除，理由随之消失。

本轮核实：`dsh-tools` 与 `dsh-llm` 的 peer 清单里**都没有** schemastery；真实 profile 两个版本都在用（`web` 是 3.18.2、`desktop` 是 3.18.1），宿主侧本无统一版本。而 `cn-capabilities` 与 `dsh-fleet` 各自的 `package.json` 都声明 3.18.1。

所以回到 3.18.1 —— 与插件自己的声明一致，消除上一轮记录的那条「插件声明相对 pin 已过时」漂移。3.18.1 与 3.18.2 均干净装通（各自实测 exit 0、`npm ls` exit 0），此处不是被迫选择。

## 真实依赖面 —— 静态扫描不够

插件源码实际导入的外部说明符：

| 说明符 | 导入者 | 形式 |
|---|---|---|
| `@deepseek-ai/schemastery` | `cn-capabilities`、`dsh-agos-router`、`dsh-fleet` | 静态 |
| `@deepseek-ai/dsh-llm` | `dsh-fleet`、`dsh-mcp-bridge` | 静态 |
| `@deepseek-ai/dsh-tools` | `dsh-fleet` | 静态 |
| `@deepseek-ai/dsh-agent` | `dsh-mcp-bridge` | 静态（第二层） |
| `@openai/codex-sdk` | `dsh-fleet/lib/fleet-codex.mjs:114` | **动态** `import()` |
| `dsh-kimicode-swarm` | `dsh-fleet`（本轮拆除）、`cn-capabilities/lib/index.js`（运行时可选） | **动态** `import()` |

⚠️ **只扫 `from '...'` 会漏掉最后两行。** 我自己第一遍扫描就漏了 `@openai/codex-sdk` 和 cn-capabilities 对 swarm 的动态引用，导致误判「Fleet 是 swarm 的唯一消费者」—— 直到 `cn-capabilities` 套件在拆除后红了 4 项才发现。这就是为什么依赖面检查必须遍历**完整导入图**（含动态 `import()`），而不是只读顶层 `dependencies` 或只匹配静态 import。该检查归 `scripts/acceptance/prepare-host-modules.mjs --check`，缺包时不得报就绪。

## 被取代的历史结论（勿再引用）

以下是上一轮（round2）写下、**已被本轮实测取代**的结论。留档是为了在别处再见到它们时能认出是历史值，不是当前依据：

- 「这份清单**不能**由 `npm ci` 复现出可用的树，不要把它当成可复现性的凭据」 → **已不成立**：本轮拆除 swarm 后 `npm ci` 实测 exit 0 可复现。
- 「树的真实性由 `verify-host-tree.mjs` 按内容摘要校验」 → **降级**：自定义内容摘要匹配只能证明「树未被本地篡改」，**不能**证明「该树等于从 registry 干净安装的结果」，不构成可复现性凭据（Luna 判定，本轮采纳）。当前凭据是 `npm ci` 本身。
- 「`@deepseek-ai/dsh-settings` 磁盘实装 0.1.0-rc.6 而非声明的 0.1.2-rc.1，`npm ls` 因此恒报 invalid，属预期稳态」 → **已消除**：该依赖整体移除，`npm ls` 现在 exit 0。
- 「swarm 按 `~/.dsh/profiles/<name>` 实装取 0.1.0」 → **已移除**：swarm 不再是声明依赖。
- 「schemastery 取 3.18.2 而非插件声明的 3.18.1，因 settings peer 要求 `^3.18.2`」 → **理由消失**，见上一节。
