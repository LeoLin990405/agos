# A 包接线单 — 可复现依赖 + 验收入口

实现者 A。worktree `/Users/<name>/Projects/agos-round2-20260908`,分支 `cursor/agos-round2-20260908`,基线 `7e7e359`。
环境:macOS 25.5.0,Node v26.7.0,npm 11.19.0。`docker`/`podman`/`colima`/`lima`/`limactl` 全部缺席(已实测),`/usr/bin/sandbox-exec` 存在。

> **所有数字都是真跑出来的。** 本轮 worktree 有 3 位实现者并发改同一棵树(记录期间 `git status` 从 0 涨到 33 个变更),
> 所以下面每个结果都注明了采集时刻与当时的树状态。**没跑过的事一件都没写。**

---

## 1. 我创建/修改的文件(精确路径)

全部新建,**没有修改任何已存在的文件**。

| 路径 | 说明 |
|---|---|
| `scripts/acceptance/README.md` | 包说明与用法 |
| `scripts/acceptance/lib/exec.mjs` | 共享执行层:跑子进程、解析 `node --test` 摘要、诚实判定、中性环境 |
| `scripts/acceptance/measure-dependency-surface.mjs` | **A1** 实测依赖面 |
| `scripts/acceptance/dependency-surface.json` | **A1** 产物:机器可读依赖面清单(65 个套件) |
| `scripts/acceptance/prepare-host-modules.mjs` | **A2** 隔离依赖树核验 + 安装 |
| `scripts/acceptance/host-deps/layers.json` | **A2** 分层安装清单 |
| `scripts/acceptance/run-acceptance.mjs` | **A3** 代码闸/漂移分离的验收器 |
| `scripts/acceptance/selftest.mjs` | **A4** 14 条负控 |
| `scripts/acceptance/mutation-check.sh` | **A4** 元证明:负控非空转 |
| `scripts/acceptance/selftest-fixtures/**` | 负控固件(故意失败/0 测试/全 skip/混合/两个漂移桩/合成 0 测试生产者) |
| `scripts/acceptance/artifacts/**` | 最近真实运行的证据(JSON + 日志 + 负控输出),92 KB |
| `docs/engineering/agos-round2-20260908/wiring/A-wiring.md` | 本文件 |

**没有产出** `scripts/acceptance/expected-counts.json`(计数下限基线)—— 理由见 §3.3。

---

## 2. 实际实现的行为

### 2.1 A1 依赖面:用 Seatbelt 拒读来测"缺依赖",不删任何人的目录

任务书假设可以"在零 node_modules 下跑每个套件"。**实际做不到**:记录期间另一位负责人已经把
`plugins/node_modules`(19 个顶层包 + `plugins/package-lock.json`)和 `plugins/dsh-mcp-bridge/node_modules` 装好了。
删掉它们去测量 = 毁掉别人的工作。

改用 `/usr/bin/sandbox-exec` **拒读**来模拟缺失,非破坏性且与谁装了什么无关,可复现:

| 模式 | 沙箱 |
|---|---|
| `natural` | 无沙箱,环境原样 |
| `no-dsh` | 拒读 + 拒写 `~/.dsh` |
| `no-host-modules` | 同上,再拒读仓内**每一个** `node_modules` 目录(等价于零依赖检出) |
| `permissive` | **方法自身的对照组**:一条限制都不加 |

`permissive` 这一组是关键的诚实性设计。`cn-capabilities/autoresearch-workspace.test.mjs` 自己要起 Seatbelt 沙箱,
套在外层沙箱里必然坏。第一版把它误判成 `host-path`;加了对照组后实测:**零限制外层沙箱下它同样挂(15 个测试挂 13 个)**,
于是改判 `sandbox-incompatible` 并写明"本方法测不了它",而不是继续给一个像模像样的错结论。

### 2.2 A1 实测结果(2026-09-08 23:3x,65 个套件)

| 分类 | 数量 | 含义 |
|---|---:|---|
| `hermetic` | 50 | 连 `~/.dsh` 和任何 `node_modules` 都不需要 |
| `host-modules` | 12 | 需要 node_modules 里的宿主裸包 |
| `host-path` | 2 | 依赖 `~/.dsh` 下的**绝对路径**,装包解决不了 |
| `sandbox-incompatible` | 1 | 本方法测不了(自带 Seatbelt) |

**真正被测试需要的外部裸包只有 2 个**(不是任务书列的 6 个):

| 包 | 需要它的套件数 | 消费者 |
|---|---:|---|
| `@deepseek-ai/schemastery` | 12 | `dsh-agos-router`, `cn-capabilities`, `dsh-fleet` |
| `@deepseek-ai/dsh-agent` | 1 | `dsh-mcp-bridge/mcp.test.mjs` |

`@deepseek-ai/dsh-llm`、`dsh-tools`、`dsh-timeout`、`dsh-kimicode-swarm`、`@openai/codex-sdk` 被插件源码 import,
但**没有任何测试套件需要它们** —— 全在懒加载分支(`await import(...)`)里。部署到真实宿主需要;离线代码验收不需要。

### 2.3 两个"装包解决不了"的可复现性地雷(需要各自 owner 修)

1. **`plugins/dsh-agos-router/test/dispatch.test.mjs:132`** 写死了绝对路径:
   ```js
   import { BlockAssembler as HostAssembler } from '/Users/<name>/.dsh/profiles/desktop/node_modules/@deepseek-ai/dsh-llm/lib/types/assembler.js'
   ```
   在本机侥幸能过(该文件确实存在);换任何一台机器必挂。`no-dsh` 模式下实测
   `ERR_MODULE_NOT_FOUND`。**这是本轮最硬的不可复现点之一。**
2. **`plugins/dsh-agos-router/test/http-routes.test.mjs`** 会写用户的**活** DSH 状态目录:
   `no-dsh` 模式下实测 `Error: EPERM: operation not permitted, open '/Users/<name>/.dsh/logs/fleet/runs.jsonl'`。
   即测试套件在污染用户真实运行日志。

### 2.4 A2 隔离依赖树

先说结论:**全部钉版宿主包在公网 registry 上都拿得到**(实测 `npm view <pkg>@<exact>`):

| 包 | 钉版 | 公网可得 |
|---|---|---|
| `@deepseek-ai/schemastery` | 3.18.1 / 3.18.2 | 是 |
| `@openai/codex-sdk` | 0.147.0 | 是 |
| `@deepseek-ai/dsh-llm` / `dsh-agent` / `dsh-tools` / `dsh-timeout` | 0.1.2-rc.1 | 是(4/4) |
| `dsh-kimicode-swarm` | 0.1.0 | 是 |

所以 A2 **不需要**从用户 profile 复制作为默认路径。`--copy-from` 只是显式操作员兜底。

⚠️ **但"拿得到"不等于"能复现上一轮的绿"** —— 主控的 `DEPENDENCIES.md` 已独立查明:上一轮的绿依赖
desktop profile 里两个本机产物(`dsh-settings@0.1.0-rc.6` 软链进 DSH Desktop.app、`dsh-kimicode-swarm` 本机构建版)。
我的验收器在纯 registry 钉版树下跑出的数字与主控"步骤 1"那一行**逐位吻合**:
`dsh-fleet 106 pass / 8 fail`、`cn-capabilities 78 pass / 4 fail`,报错同为
`'@deepseek-ai/dsh-settings' does not provide an export named 'installSettingsSection'`。
两套独立工具互相印证了同一条根因链。

**硬安全不变量(全部实测触发过,见 §4.3):**
1. 安装根落在 `~/.dsh` 下 → 退出 2,拒绝
2. 层 `node_modules` 是软链 → 退出 2,**绝不穿过软链安装**
3. `<target>/node_modules` 已存在 → 不覆盖(并发保护)
4. `--copy-from` 必须显式给路径,无默认值;只读复制;绝不软链;绝不把源目录当安装目标;源在 `~/.dsh` 内时大字标注
5. 缺依赖 → 指名道姓诊断 + 非零退出,**绝不假装通过**

判据是**从消费者角度能否解析**(照 Node 对裸规格的真实算法逐级向上找 `node_modules/<pkg>`),
而不是看谁的 `package.json` 写了什么。版本与声明不一致单独列为 `pinConformance` 报出,默认不阻断(`--strict-pins` 可阻断)。

### 2.5 A3 三条不混的通道

- **codeGates** —— 唯一决定进程退出码。
- **advisory** —— 部署漂移。真实退出码原样进 JSON 和终端(带 `ADVISORY` 标签),**永不**参与退出码,也**永不**被吞。
- **preflight** —— 依赖面预检。实测需要的包缺了 → 该闸判 `missing-host-modules` **失败**(退出码 78),绝不降级成 skip。

默认环境:`SESSION_MEMORY_CORPUS_DIR` 指向一个**不存在**的临时路径(与上一轮同法),
并从子进程环境剔除 `Z_AI_API_KEY`/`GLM_API_KEY`/`OPENAI_API_KEY`/`ANTHROPIC_API_KEY`/`NODE_PATH`/`NODE_TEST_CONTEXT`/`NODE_OPTIONS`。

JSON 每个套件记录:`argv`、`cwd`、`exitCode`、`counts{tests,pass,fail,skipped,cancelled}`、`verdict`、`reason`、
`durationSeconds`、`log`、`logSha256`、`missingModules`。

### 2.6 诚实判定表

| 情况 | verdict | 算绿 |
|---|---|---|
| 退出 0、有摘要、fail 0、tests>0、pass>0 | `pass` | ✅ |
| 退出非 0 / 报了 fail / **压根没有摘要** | `fail` | ❌ |
| 退出 0 但 tests 0 | `empty` | ❌ |
| 有测试但一条都没真过(全 skip) | `skipped` | ❌ |
| 测试数低于基线下限 | `fail` | ❌ |

`skip` 数永远单列,**永不**并入 `pass`。

**一个必须记录的 Node 行为**:Node v26 的 `--test` 把一个**没注册任何测试**的文件本身算成 **1 个通过的测试**。
所以"清空测试文件"这种作弊,光看 `pass > 0` **抓不到**。这是为什么加了 `expected-counts.json` 计数下限闸
(`minTests`/`minPass`),并且 `--write-floors` **拒绝**从非全绿的运行生成基线。负控 NC6b 把这个 Node 行为
和下限闸的效果都钉住了。

---

## 3. 需要主控接线的地方(我不动,主控来动)

### 3.1 `scripts/test-all.sh` —— 让部署漂移不再拉红代码闸

现状(第 50–52 行)把漂移并进 `rc`,于是未部署的分支必然非零。建议改成 advisory:

```diff
 print "▸ deploy drift"
-"$ROOT/scripts/deploy-plugins.sh" --check || rc=1
+# 部署漂移是环境事实(未部署的分支必然非零),不是代码缺陷:只报,不参与退出码。
+# 真实退出码照打,不吞。想要机器可读结果与负控,走 scripts/acceptance/run-acceptance.mjs。
+drift_rc=0
+"$ROOT/scripts/deploy-plugins.sh" --check || drift_rc=$?
+print "ADVISORY: deploy drift exit ${drift_rc}(不参与代码闸退出码)"
 exit $rc
```

我**没有**改这个文件(controller-only)。改与不改都不影响 `scripts/acceptance/` 独立可用。

### 3.2 CI / 验收流水线(建议顺序)

```sh
# 1) 依赖面体检:不就绪就带指名诊断非零退出
node scripts/acceptance/prepare-host-modules.mjs --check
# 2) 验收:代码闸决定退出码,部署漂移只报
node scripts/acceptance/run-acceptance.mjs --with-frontend --json=acceptance-results.json
# 3) 负控:证明验收器没法谎报
node --test scripts/acceptance/selftest.mjs
# 4) 元证明:证明负控不是空转
zsh scripts/acceptance/mutation-check.sh
```

### 3.3 计数下限基线 —— 需要主控在本轮**收尾时**生成

我故意**没有**提交 `expected-counts.json`。记录期间测试数一直在涨
(`dsh-agos` 154→165→172、`dsh-agos-router` 91→97→101→115、`cn-capabilities` 82→106→108、`dsh-fleet` 137→148),
此刻固化下限只会给别人制造假报警。等树稳定后由主控跑:

```sh
node scripts/acceptance/run-acceptance.mjs --write-floors=scripts/acceptance/expected-counts.json
```

该命令**只在全绿时**写文件(实测:红的时候拒绝,见 NC9)。文件不存在时验收器会告警,并明确说"删测试抓不到"。

### 3.4 `frontend/package.json`

**不需要任何改动。** `--with-frontend` 直接调 `npm run verify`,实测通过(§4.2)。

### 3.5 转给各 owner 的修复项(不是接线,是缺陷)

| 项 | 文件 | 建议 |
|---|---|---|
| 写死绝对路径 | `plugins/dsh-agos-router/test/dispatch.test.mjs:132` | 改成从仓内解析或跳过并注明,别指 `~/.dsh/profiles/desktop/...` |
| 污染用户活状态 | `plugins/dsh-agos-router/test/http-routes.test.mjs` | 把 `DSH_FLEET_*` 路径指到临时目录 |
| 钉版声明不一致 | `plugins/cn-capabilities/package.json`、`plugins/dsh-fleet/package.json` 声明 `schemastery 3.18.1`,树里是 `3.18.2` | 统一到 `plugins/package.json` 的 3.18.2 |

---

## 4. 我实际跑过的命令(真实退出码)

### 4.1 A1 实测

```
node scripts/acceptance/measure-dependency-surface.mjs        → 退出 0(121 s)
```
65 个套件 × 3–4 模式。结果:`hermetic 50 / host-modules 12 / host-path 2 / sandbox-incompatible 1`。

### 4.2 A3 验收(多次,树在变)

| 时刻 | 命令 | 退出码 | pass / fail / skip | 说明 |
|---|---|---:|---|---|
| 运行 1 | `run-acceptance.mjs` | **1** | 439 / 12 / 2 | 纯 registry 钉版树状态。`dsh-fleet 106/8`、`cn-capabilities 78/4`,与主控 `DEPENDENCIES.md` 步骤 1 逐位吻合 |
| 运行 2 | `run-acceptance.mjs` | **0** | 502 / 0 / 2 | 主控替换两个本机产物之后 |
| 运行 3 | `run-acceptance.mjs --write-floors=...` | **1** | 514 / 1 / 2 | 并发编辑导致 1 挂;`--write-floors` **拒绝**写基线 |
| **最终存档** | `run-acceptance.mjs --json=artifacts/acceptance-results.json` | **0** | **540 / 0 / 2** | 五个插件闸全绿;漂移 ADVISORY 退出 1 未影响 |
| 加前端 | `run-acceptance.mjs --with-frontend --no-advisory` | **1** | 912 / 1 / 3 | `frontend-verify` **通过**(365/0/1,退出 0);`dsh-agos-router` 1 挂(见下) |
| **交付时最后一次** | `run-acceptance.mjs --no-advisory` | **1** | 547 / 1 / 2 | 交付时刻的真实状态:`dsh-agos-router` 116 个测试中 1 挂,其余四个闸全绿 |

**最终存档那一次的逐套件明细**(`scripts/acceptance/artifacts/acceptance-results.json`,`gitHead 7e7e3598`,当时 32 个未提交变更):

| 套件 | 退出 | pass/fail/skip | 时长 | logSha256 前 12 位 |
|---|---:|---|---:|---|
| `dsh-agos` | 0 | 165 / 0 / 2 | 0.60 s | `a95b77d8220a` |
| `dsh-agos-router` | 0 | 115 / 0 / 0 | 5.13 s | `1f41b496a5ec` |
| `dsh-mcp-bridge` | 0 | 4 / 0 / 0 | 0.13 s | `383a055f6ffb` |
| `cn-capabilities` | 0 | 108 / 0 / 0 | 11.96 s | `abc67f57a528` |
| `dsh-fleet` | 0 | 148 / 0 / 0 | 6.03 s | `239d64011c2e` |
| **ADVISORY** `deploy-drift` | **1** | — | 0.19 s | `8253565f7625` |

代码闸 = 绿,进程退出码 = 0,**漂移退出 1 没有把它拉红**;漂移的真实退出码 1 完整留在 JSON 与终端摘要里。

那 2 个 skip 是 `dsh-agos` 的私有语料测试,因 `SESSION_MEMORY_CORPUS_DIR` 指向不存在路径而自报跳过。**它们不是通过。**

> ⚠️ **写这份文档时**(比最终存档更晚)`dsh-agos-router` 有 1 条挂:
> `test/dispatch.test.mjs:295` "the verdict booking reads and appends strictly inside one transaction",
> 期望 `'enter'` 实得 `'read-OUTSIDE'`。那是 router owner 正在做的事务化改造的在途状态,
> 不是我的工具的问题,也不在我的文件范围内。**当前树的代码闸是红的。**

### 4.3 A2 核验与安全不变量(逐条实跑)

| 检查 | 命令 | 退出码 | 结果 |
|---|---|---:|---|
| 依赖面核验 | `prepare-host-modules.mjs --check` | **0** | 实测需要的 2 个包全部可解析;报出 2 处钉版声明不一致 |
| 拒绝装进 `~/.dsh` | `--prefix=$HOME/.dsh/profiles/desktop/nm-test` | **2** | 拒绝 |
| 拒绝穿过软链安装 | 层 `node_modules` → `~/.dsh/profiles/node_modules` | **2** | 拒绝,且**确认 profile 内没有被写入任何东西** |
| 缺包诊断 | `--offline --surface=<合成>` | **1** | 点名 `@agos-selftest/definitely-not-real` + 3 条操作员选项;**不是** skip、**不是** pass |
| 真实隔离安装 | `--prefix=<临时> --layers=<合成>` | 装成功 | `@deepseek-ai/dsh-plan-mode@0.1.2-rc.1` 落进隔离前缀;用户 profile 内该包仍是 8 月 21 日的旧软链,**未被触碰** |
| `--link` 机制 | `--link` 指到我自己的目录 | 建链成功 | 建出仓内相对软链并可用(读到 `0.1.2-rc.1`);对已存在的 `plugins/node_modules` 实测**跳过不覆盖** |

### 4.4 公网可得性

`npm view <pkg>@<exact> --registry=https://registry.npmjs.org` 对 9 个 (包,版本) 组合逐一实跑,**9/9 可得**。
另实测确认 peer 冲突真实存在:`dsh-kimicode-swarm@0.1.0` → `@deepseek-ai/dsh-commands` → peer
`@deepseek-ai/dsh-agent@^0.0.1-rc.1`,与 pin `0.1.2-rc.1` 冲突,`npm install` 报 `ERESOLVE`。
这印证了 `plugins/package.json` 把 `dsh-agent` 单独下放到 `plugins/dsh-mcp-bridge/` 的分层是对的。
**没有**用 `--force` / `--legacy-peer-deps` 掩盖。

---

## 5. 负控结果

### 5.1 14 条负控全过(`node --test scripts/acceptance/selftest.mjs` → 退出 **0**)

| 编号 | 断言 | 结果 |
|---|---|---|
| META | 真能过的套件 → 退出 0、`pass`、闸绿(否则永远报红的验收器会白拿满分) | ✔ |
| NC1 | 失败套件在 JSON(`verdict fail`)和退出码(1)里都保持失败;生产者退出码原样保留 | ✔ |
| NC2 | 0 测试 + 退出 0 → `empty`,**不算过**,闸变红,进程非零 | ✔ |
| NC2b | `verdictOf` 纯逻辑:`tests=0`→`empty`;**没有摘要**→`fail` | ✔ |
| NC3a | 漂移退出 1 + 代码闸全过 → 进程退出 **0**;漂移真实退出码 1 仍在 JSON 里;终端有 `ADVISORY` 字样;漂移不混进代码闸套件列表 | ✔ |
| NC3b | 漂移零漂移(退出 0)**救不了**失败的代码闸 | ✔ |
| NC4 | 缺必需宿主包 → `verdict fail` + `missing-host-modules` + 点名包名;**不是** `skipped`、**不是** `pass`;进程非零 | ✔ |
| NC5a | 全 skip → `verdict skipped`,`pass=0`,`skipped=2`,闸**不绿** | ✔ |
| NC5b | pass+skip 混合 → `pass=2`、`skipped=1`(不是 3);两数之和等于 tests | ✔ |
| NC6 | 测试数低于下限 → `fail`(`count-regression`) | ✔ |
| NC6b | 记录 Node v26 把空测试文件算成 1 个**通过**;无下限时确实会判过(**这是明写的局限,不是主张**);加下限即抓到 | ✔ |
| NC7 | 语料目录是不存在路径;4 个供应商密钥被剔除 | ✔ |
| NC8 | 朴素 `cmd \| grep` 把失败洗成 0(实测);验收器保留生产者的 1 | ✔ |
| NC9 | `--write-floors` **拒绝**从红的运行写基线,且不产出文件 | ✔ |

### 5.2 元证明:负控不是空转(`zsh scripts/acceptance/mutation-check.sh` → 退出 **0**)

负控全绿本身**什么也证明不了** —— 空转的自检也会全绿。所以把验收器逐条改坏,要求特定负控必须变红。
改坏的副本跑完即删,真的 `run-acceptance.mjs` 不动(已核对)。

| 变异体 | 改坏内容 | 被抓到的负控 |
|---|---|---|
| `drift-into-gate` | 漂移并进代码闸(advisory 通道消失) | NC3a, NC3b |
| `skip-as-pass` | `skipped` 并进 `pass` | NC5a, NC5b |
| `green-always` | 只看退出码不看 verdict | NC2, NC5a, NC6, NC6b |
| `missing-dep-as-skip` | 缺宿主包降级成 skip | NC4 |
| `exit-always-zero` | 进程退出码恒为 0 | NC1, NC2, NC3b, NC4, NC6, NC6b |

**5/5 变异体全部被抓。**

### 5.3 负控在开发中真的抓到了一个我自己的 bug

第一版负控里 8 条挂了。根因不是固件写错,而是**验收器真有毛病**:
`node --test` 会设 `NODE_TEST_CONTEXT`,而验收器把整个环境透传给子进程 →
子进程的 `node --test` 认为自己是嵌套调用,打印 `Warning: node:test run() is being called recursively... skipping running files`,
**一个测试都不跑却退出 0**。那正是最危险的假绿。已在 `lib/exec.mjs` 的 `neutralEnv()` 里剔除该变量并注明原因。

---

## 6. 日志与产物路径

| 产物 | 路径 |
|---|---|
| 依赖面清单(A1) | `scripts/acceptance/dependency-surface.json` |
| 验收结果 JSON(A3,最终存档) | `scripts/acceptance/artifacts/acceptance-results.json` |
| 逐套件日志 + SHA256 | `scripts/acceptance/artifacts/logs/{dsh-agos,dsh-agos-router,dsh-mcp-bridge,cn-capabilities,dsh-fleet,deploy-drift}.txt` |
| A2 核验报告 | `scripts/acceptance/artifacts/host-modules-check.json` |
| 负控输出 | `scripts/acceptance/artifacts/selftest.txt` |
| 元证明输出 | `scripts/acceptance/artifacts/mutation-check.txt` |
| A1 逐模式原始日志(**临时,会被清掉**) | `$TMPDIR/agos-acceptance-surface-logs/{natural,no-dsh,no-host-modules,permissive}/<plugin>/<file>.txt` |

`artifacts/` 共 92 KB。A1 的逐模式日志(65×4 个文件)刻意留在 `$TMPDIR`,没塞进仓里;
`dependency-surface.json` 内每个套件都带该日志的相对路径与报错摘要,重跑一条命令即可再生。

---

## 7. 未解决的风险 / 我**没能**验证的事

**必须说清的限制:**

1. **本轮当前的代码闸是红的。** 写这份文档时 `dsh-agos-router/test/dispatch.test.mjs:295` 有 1 条挂
   (事务化改造在途)。我最终存档的 540/0/2 全绿是**更早时刻**的快照。**我没有主张 CI 是绿的。**
2. **所有数字都是移动靶上的采样。** 3 位实现者并发改同一棵 worktree,记录期间测试总数从 453 涨到 916。
   任何单次运行的数字都只对采集那一刻有效。这也是我拒绝提交计数下限基线的原因(§3.3)。
3. **`cn-capabilities/autoresearch-workspace.test.mjs` 的依赖面我测不了。** 它自带 Seatbelt 沙箱,
   零限制外层沙箱下也挂 13/15。清单里如实标成 `sandbox-incompatible` 并写明原因,**没有**猜一个结论填上。
4. **`plugins/node_modules` 不是我装的,我也没验证它的完整来源。** 它由另一位负责人用
   `plugins/package.json` + `plugins/package-lock.json`(registry.npmmirror.com)加上两个本机产物替换而成。
   我只验证了"实测需要的裸包能否从消费者角度解析"以及版本与声明是否一致。
   **我没有**独立复现那棵树的构建,也**没有**核对它每个包的内容哈希 —— 那是主控 `DEPENDENCIES.md` 的工作。
5. **`--copy-from` 的复制路径我只在"源缺包 → 告警"的分支上跑过**,没有真的从
   `~/.dsh/profiles/node_modules` 完整复制过一次(没有必要:全部钉版包公网可得,且我不想在用户 profile 上多做读操作)。
   复制逻辑本身(`cpSync` + 大字标注 + 拒绝软链)**未经端到端实跑验证**。
6. **零 Linux 容器能力。** `docker`/`podman`/`colima`/`lima`/`limactl` 全缺席(已实测)。
   所以"干净机器上能复现"这件事**只是推断**,由"钉版包公网 9/9 可得"支撑,**没有**在第二台机器或容器里真的验证过。
   这是本轮最大的未验证缺口。
7. **计数下限闸只在合成固件上验证过**(NC6/NC6b),没有在真实插件套件上跑过 —— 因为真实基线还没定(§3.3)。
8. **Seatbelt 拒读只能证明"不需要",不能证明"不会用"。** 一个走懒加载分支的依赖,只要该分支在测试里没被走到,
   就会被判成 `hermetic`。所以 §2.2 那句"只有 2 个包被测试需要"严格说是
   "**在当前测试覆盖下**只有 2 个包会被解析",不是"插件运行时只需要 2 个包"。运行时清单见 `host-deps/layers.json` 的
   `runtimeOnlyNotRequiredByTests`。
9. **没做的事(按纪律):** 没有真实付费模型调用;没有读 `~/.dsh/sessions*` 或 `~/.claude/projects`;
   没有部署、没有重启 DSH;没有动 `frontend/UPSTREAM.pin`、`contract-baseline.sha256` 或任何适配器哈希;
   没有 `git commit/checkout/reset/stash/clean/restore`;没有改动上一轮的冻结证据;
   没有往 `~/.dsh/profiles/**` 写入任何东西(实测确认);没有创建根 `node_modules` 或 `plugins/node_modules` 软链。
