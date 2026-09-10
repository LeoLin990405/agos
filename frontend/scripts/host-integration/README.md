# host-integration:真宿主联测的基础设施

这一层只做一件事:**把一个真的 dsh 宿主、一个真的 SPA 源、一个真的浏览器拉起来,并保证
拉起失败时不留残骸、清理时不误伤别人、日志里不留可重组的凭据、浏览器出不去本次的两个
origin。** 场景判定不在这里,在 `frontend/tests/host-integration/`(见下)。

> 本文件里的相对路径都以 **`frontend/`** 为基准(`scripts/host-integration/…`、
> `tests/host-integration/…`),命令也都在 `frontend/` 下执行。

## 文件

### 基础设施(本目录)

| 文件 | 职责 |
|---|---|
| `host-env.mjs` | 子进程环境构造(凭据剥离、`DSH_*` 剥离)、端口认领、脱敏规则、`waitFor` |
| `run-registry.mjs` | 运行身份:runId、owner token、进程身份(pid + 内核启动时刻 + argv)、孤儿判定与回收 |
| `resource-stack.mjs` | 分级资源栈:任一级失败/取消/卡死都就地逆序回收 |
| `redact-stream.mjs` | 跨 chunk 边界安全的脱敏写入器 |
| `browser-source.mjs` | Playwright / 浏览器来源解析(不借 live profile)+ 外部 origin 拦截 |
| `start-host.mjs` | 拉起真宿主、换取会话 cookie、挂载插件、验证插件加载 |
| `ui-server.mjs` | Vite 起 SPA 源,`/api` 中继到真宿主 |
| `fake-harness-plugin.mjs` | 挂进真宿主的**真** cordis 插件。它只假冒**模型**与**工具体**——宿主、agent 循环、审批接缝、会话日志、api-gateway、`/api/remote.mux` 传输全是真的。唯一注册的 provider 是 `agos-fake`,零付费 token、零网络 I/O |
| `cleanup.mjs` | 只回收**没人认领**的运行,活跃运行一律跳过并报出 |
| `probe-host.mjs` | 无浏览器的传输层探针 |

### 场景与结果(`frontend/tests/host-integration/`)

| 文件 | 职责 |
|---|---|
| `run.mjs` | 联测入口。每个场景在 `exercises` 里声明它**真正驱动到**的层,标签随结果进报告 |
| `scenarios.mjs` | 场景判定 |
| `harness.mjs` | `createHarness`——把上面的基础设施组装成一次完整运行 |
| `unit/` | 基础设施自己的回归(不需要完整依赖树) |
| `artifacts/` | 最近一次运行的截图与日志。**`.gitignore` 挡掉,不入库** |

⚠️ `artifacts/` 不入库的第二个理由是硬的:它**必然含个人绝对路径**——实测一次运行的产物里
有 43 处 `/Users/<name>/…`,分布在 `host.log`(30)、`results.json`(9)、`probe-host.log`(2)、
`run.log`(1)、`probe-host-findings.json`(1)。宿主与 Playwright 都会把绝对路径打进日志,
截图也可能带上工作树路径。**这不是靠"记得脱敏"能解决的**,所以从入库层挡掉。
需要交付证据时,把**脱敏后的副本**放进 `docs/engineering/<轮次>/logs/` 并在文件头声明脱敏范围。

## 挂载插件 + 查询实际加载

> 这一节原是第三轮为当时的实施者 D 写的接口说明。**接口本身仍然有效**,
> 只是"D"在不同轮次指不同的人,所以这里按能力而不是按人来写。

联测需要在临时宿主上挂真实插件(例如 `plugins/dsh-agos` 的 turn-evidence)时,用下面两个
接口。**关键约定:`loaded` 不是"我请求了所以它在",而是对运行中的宿主实际探测出来的结果。**
`loaded !== true` 时应判 `blocked`,不要把由此产生的 404 当成产品缺陷。

### 1. 指定要加载的插件

```js
/**
 * @typedef {Object} HostPluginSpec
 * @property {string}  id        - loader id,overlay 内唯一,也是 status 的报告键
 * @property {string} [entry]    - 插件入口的绝对路径(loader 会转成 file:// URL,无需安装),
 *                                 或可从临时 profile 解析的裸包名。与 `disabled: true` 二选一
 * @property {object} [config]   - 传给该插件的 loader config
 * @property {boolean}[disabled] - 按 id 关掉一个已组合的插件
 * @property {HostPluginProbe} [probe] - 如何**验证**它真的加载了;不给则报 loaded: null
 */

/**
 * @typedef {{kind:'unary', method:string, args?:object}     // POST /api/<method>,看 result.ok
 *         | {kind:'http',  path:string, method?:string, body?:unknown}  // 任意路由,404 即未加载
 *         | {kind:'log',   pattern:string}                  // 宿主日志正则
 *         | {kind:'none'}} HostPluginProbe
 */
```

两个入口都收 `plugins: HostPluginSpec[]`:

```js
// 直接用 launcher(无浏览器)
const host = await startHost({
  dshHome, workspace, hostPort, uiPort, controlFile, logPath,
  runDir, runId, ownerToken,                  // 可选:交给 cleanup 认领
  plugins: [{
    id: 'dsh-agos',
    entry: '/abs/path/to/plugins/dsh-agos/lib/index.js',
    probe: { kind: 'unary', method: 'turn-evidence/list', args: { request: {} } },
  }],
})

// 或者整套联测
const ctx = await createHarness({
  plugins: [ /* 同上 */ ],
  signal,                 // 可选:AbortSignal,取消会逐级回收
  bringUpTimeoutMs,       // 可选:仅约束拉起阶段
})
```

### 2. 查询实际加载成功的插件

```js
/**
 * @typedef {Object} HostPluginStatus
 * @property {string}       id
 * @property {string}      [entry]
 * @property {boolean}      requested - 调用方请求过
 * @property {boolean}      mounted   - 入口存在且进了 overlay
 * @property {boolean|null} loaded    - 探测结论;null = 没声明 probe,**未验证**
 * @property {string}       detail    - 结论的依据原文(例如 "POST /api/… → 404 (route not mounted)")
 */

await host.pluginStatus()      // => Promise<HostPluginStatus[]>,每次都重新探测运行中的宿主
await host.loadedPlugins()     // => Promise<string[]>,只含 loaded === true 的 id
host.lastPluginStatus()        // => 上一次的结果,不重新探测(写报告用)

// harness 上的同一组接口
ctx.plugins.requested          // => HostPluginSpec[]
await ctx.plugins.status()     // => HostPluginStatus[]
await ctx.plugins.loaded()     // => string[]
```

典型用法(pass / blocked 判定):

```js
const loaded = await ctx.plugins.loaded()
if (!loaded.includes('dsh-agos')) {
  // 证据插件没起来 —— 这是 blocked,不是 fail
  return ctx.record(false, `blocked: dsh-agos 未加载 —— ${JSON.stringify(await ctx.plugins.status())}`)
}
```

## 其他调用方需要知道的行为变化

> 以下条目均为**第三轮**定型的行为,除非另有标注。

- **`createHarness` 拉起失败会自己回收。** 不要再指望"拿到 harness 再 dispose":任一级失败
  时,该级之前已创建的宿主进程、端口、临时目录、浏览器都已在抛出前逆序回收。
- **临时目录换成了「一次运行一个根」**:`<tmp>/agos-host-integration-run-<runId>-XXXX/`,
  里面是 `owner.json`(所有权清单)、`home/`(DSH_HOME)、`workspace/`。
- **`cleanup.mjs` 不再按前缀杀。** 它读每个运行根的 `owner.json`:创建者进程还活着的运行
  一律跳过并打印;要杀某个 pid,必须 pid + 内核启动时刻 + argv 三者都还对得上。
  `--dry-run` 只分类不动手,`--root <dir>` 指定扫描目录。
- **宿主和浏览器都进清单。** Playwright 不把它启动的浏览器 pid 交出来,所以 harness 用
  「启动前后自己直接子进程的差集 + argv 确认是浏览器」把它找出来再记账;否则一次被遗弃的
  运行会留下一个谁都认不出的 headless 浏览器。清单里每条进程记 `pgid` 与 `runIdInCommand`:
  - `pgid === pid`(自己是进程组长)时按**进程组**发信号,因为浏览器是一棵树,只杀父进程会
    留下 renderer / GPU 助手;进程组不等于本进程组才会动手。
  - 宿主的 argv 含 runId(`--patch` 路径在运行根里),所以杀它要求 argv 仍含 runId;浏览器的
    argv 只含 Playwright 自己的随机 profile 路径,永远不含 runId,对它的规则是
    pid + 内核启动时刻 + argv 逐字节相等。这个区别在**记账时**判定并写进清单。
- **浏览器只被允许访问本次的两个 origin**,其余请求一律 abort 并记进 `ctx.blockedRequests`。
- **关浏览器有时间上限。** 对着已安装的 Google Chrome,`browser.close()` 实测要 30 秒
  (Playwright 等整棵进程树)。dispose 与「拉起失败逐级回收」都会付这 30 秒,所以宽限
  2.5 秒后直接对进程组发 SIGKILL 并停止等待 —— profile 是一次性的,没有需要优雅退出保存的
  东西。**第三轮在本机实测 30.1s → 2.7s**(数量级参考,不同机器与 Chrome 版本会变)。
- **Playwright 不再默认借 `~/.dsh`。** 顺序是:`AGOS_PLAYWRIGHT_MODULE` → 本仓依赖树
  (`frontend/`、`plugins/`、仓库根)→ 抛 `IntegrationBlocked`(`error.blocked === true`)。
  确实要借 live profile 必须同时设 `AGOS_ALLOW_LIVE_PROFILE=1`。
  这是有意的:harness 的契约是「绝不读 `~/.dsh`」,而它原先的默认解析路径正是
  `~/.dsh/profiles/web/node_modules/playwright-core`。
- 浏览器可执行文件**从系统里找**(Chrome / Chromium),**从不下载**;找不到设
  `AGOS_BROWSER_EXECUTABLE`。

### 第四轮(2026-09-09)的可移植性改造（当前工作树记录，尚待冻结验收）

C 改了定位与身份,使缺组件报 `blocked` 而不是把「本机观察不到」写成产品失败。
Playwright 解析顺序**未改**,仍是上一节那条。

**dsh CLI**(`resolveDshBin`):`AGOS_DSH_BIN`(可为命令名,走 PATH)→ `~/.npm-global/bin/dsh` → PATH 上的 `dsh` → `IntegrationBlocked`。不再在 overlay/端口都建好之后才 ENOENT。

**浏览器**(`resolveBrowserExecutable`):显式覆盖(**现在接受命令名**,走 PATH)→ 按平台绝对路径 → PATH → `blocked`。
Linux 候选补了 `/usr/bin/google-chrome-stable`、`/snap/bin/chromium`、`chromium-browser`。macOS 候选逐字未变。
本机 Linux 候选**没有**对着真实 ELF 二进制跑过。

**进程身份**:`ps -o lstart=` 优先,`/proc/<pid>/stat` 兜底;身份带 `backend` 字段;**跨后端一律 fail-closed**(理由写「backend 不一致」,不谎报 pid reused)。
`/proc` 解析器只用文档格式 fixture 验过,活内核未验。

**`run.mjs`**:新增 `--logdir`,写出 `<logdir>/host-browser.json`(`integration-layer@1`)。bring-up 因缺 Chrome / Playwright / dsh 抛 `IntegrationBlocked` 时判 **blocked**,不判 fail。

**场景 5**:不再依赖页内 5ms `setInterval`(Chrome 后台节流约 14 倍;开工基线实测 8 pass / 1 fail)。改为断言订阅回调里的 `getSnapshot()` 必须出现 online→down 跃迁;5ms 轮询只要求还在跳。这是抗 flake 的判据替换,不是加严。

**主控独立复跑**（非冻结记录）：host unit 111/111；9 场景 9/9 exit 0。Linux 宿主联测**未跑**；Linux 隔离层当前实测为 `blocked`。

## 跑测试

```sh
cd frontend

# 基础设施自己的回归(不需要完整依赖树)
node --test "tests/host-integration/unit/*.test.mjs"

# 真浏览器那条用例:装了 frontend/node_modules 就自动跑;没装时可以显式指路
AGOS_PLAYWRIGHT_MODULE=/abs/path/to/playwright-core/index.mjs \
  node --test tests/host-integration/unit/browser-isolation.test.mjs

# 整套真宿主联测(需要系统里已装 Chrome / Chromium)
node tests/host-integration/run.mjs --logdir /tmp/host-layer
node tests/host-integration/run.mjs --only <id>[,<id>…]     # 只跑指定场景
```

## 清理

```sh
cd frontend
node scripts/host-integration/cleanup.mjs --dry-run   # 只分类,不动手
node scripts/host-integration/cleanup.mjs             # 只回收没人认领的运行
```

并行跑联测是安全的:别人还活着的运行会被打成 `active` 并原样跳过,输出里点名说明跳过了谁、
为什么跳过。
