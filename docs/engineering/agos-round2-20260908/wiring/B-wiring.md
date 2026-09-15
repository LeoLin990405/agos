# B 包接线单 — 真实 pinned host + 真实浏览器集成测试

实现者 B。worktree `/Users/<name>/Projects/agos-round2-20260908`,分支 `cursor/agos-round2-20260908`,基线 `7e7e359`。
环境:macOS darwin 25.5.0,Node v26.7.0,npm 11.19.0,Chrome 152.0.7977.82,`dsh` 0.1.2-rc.1(`a66e470204`)。

## 结论(先说最重要的一句)

**real-host E2E:已达成(ACCEPTED)。** 八个场景全部跑在**真的 pinned `dsh` 宿主**上,由**真的 Chrome**
驱动**真的 `ChatPage`**,走**真的 `/api` + `/api/remote.mux` 传输**,断言读的是**真的 `live.ts` 单例 store**。
没有组件固件,没有手喂状态,没有 mock 掉的 HTTP 响应体。

**最终一次全量运行:9/9 PASS,74 条断言,真实退出码 0,宿主退出码 0。**

必须同时看清的三条边界(详见 §7):

1. SPA 由 **Vite dev server** 提供(生产 `dist` 构建归控制者,我没跑 `npm run build`)——是真源码真组件,不是发布产物。
2. `/api` 经过**我自己的一跳 Vite 代理**(注入宿主签发的 cookie、改写 `Origin`/`Host`),否则过不了浏览器信任栅栏。
3. **模型和工具是假的**(唯一注册的 provider 是 `agos-fake`),零真实模型调用、零付费 token。

---

## 1. B1 结论:能不能起一个真正隔离的 pinned 宿主

**能。** 关键不是命令行参数,而是 `DSH_HOME` 环境变量——它是 harness 自己文档化的 home 覆盖点,
`HOME` / `CODEX_HOME` 一律没碰。

### 1.1 `dsh --help`(逐字)

```
Usage: dsh [options] [command] [args...]

Options:
  -V, --version               output the version number
  --profile <name>            the profile under $DSH_HOME/profiles to boot
  --patch <path>              extra patch-list overlay applied after the profile
                              layer (repeatable)
  --dump-config               print the composed profile tree and exit
  --dump-default-config       print the profile tree without its user layer or
                              --patch overlays and exit
```

**没有** `--profile-dir` 之类的"专用目录"参数。`--profile <name>` 解析的是 `$DSH_HOME/profiles/<name>`,
所以**隔离点是 `$DSH_HOME`**:把它指向临时目录,profile、sessions、storages、settings 全部落在临时树里,
`~/.dsh` 既不读也不写。任务书里"如果只能写 `~/.dsh` 就停下来报告"的分支**没有触发**。

### 1.2 web app 自己的参数(逐字)

`dsh web --help` 在**用户自己的** `~/.dsh/profiles/web` 上**起不来**(见 §7.5),所以这份帮助是在隔离 home 里取的:

```
$ TMPH=$(mktemp -d); DSH_HOME="$TMPH" dsh --profile web --help
Usage: dsh --profile web [options]

Options:
  --host <host>                  bind host
  --no-open                      do not open the Web UI in the default browser
  --port <port>                  listen port; pass 0 to let the OS pick a free one
  --trusted-host <authority...>  extra authority the /api browser-trust fence
                                 accepts (host or host:port; repeatable)
```

四个都用上了。`--trusted-host` 是必需的:SPA 从 Vite 的 authority 访问,宿主的 `/api` 浏览器信任栅栏
默认只认自己的 authority,不声明就全部 403。

### 1.3 隔离 home 里跑的是 pinned 代码,且没有任何下载

`dsh` 会用模板自动创建 profile,并把插件依赖**软链**到全局 pinned 安装:

```
$ ls -l $TMPH/profiles/node_modules/@deepseek-ai/ | head -3
cordis -> /Users/<name>/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis
cordis-plugin-group -> /Users/<name>/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis-plugin-group
```

冷启动 **0.695s**,期间没有 `pnpm` / `npm install` 子进程。也就是说:隔离 ≠ 换了一份代码,跑的就是 pin 住的那份。

### 1.4 端口

`claimPorts()` 从 **39411** 起逐个 `net.createServer().listen()` 试探,只拿探到空闲的端口,每轮要两个
(宿主 + SPA)。用户自己的 DSH 在别的端口上,全程没有绑定或干扰。最终一轮实际用的是 39411/39412。

### 1.5 零真实模型调用(不是"应该不会",是"没有路可走")

`--patch` overlay 直接把真 provider 摘掉,只留假的:

```json
[
  { "id": "llm-deepseek",           "disabled": true },
  { "id": "web-search-deepseek",    "disabled": true },
  { "id": "session-telemetry-otel", "disabled": true },
  { "id": "agent-default-model", "config": { "provider": "agos-fake", "model": "agos-fake-1" } },
  { "insert": [{ "id": "agos-fake-harness", "name": "<临时 profile>/agos-harness/index.mjs" }] }
]
```

再加两道:子进程环境里**所有凭据形状的变量被剥离**(24 个,名字记录在 `host.log` 头部,值从不落盘),
以及宿主自报的 provider 清单:

```
ONLY the fake provider is registered (no paid route exists)   providers=["agos-fake"]
```

### 1.6 B1 探针(在写任何测试之前跑的)

`scripts/host-integration/probe-host.mjs` 的 11 项全绿,产物 `artifacts/probe-host-findings.json`。
它证明的是**真实线协议**可用,而不是 UI 好看:

| 探针项 | 结果 |
|---|---|
| 真 pinned 宿主在隔离 `DSH_HOME` 上启动 | ok |
| unary `session/list` / `session/create` | ok |
| 只注册了假 provider | `providers=["agos-fake"]` |
| `/api/remote.mux` `$events` 收到 `ready` 帧 | `clientId` / `home` 均在 |
| 真 `session/follow` 开窗快照 | `cursor=2 hasMore=false` |
| `session/prompt` 被真 agent loop 接受 | ok |
| 真 `approval/request` waterfall 到达客户端 | `agentId` / `callId` 均在 |
| `$events/result` 回答真 waterfall | ok |
| 宿主决定出现在真 `session/follow` 流上 | `event=approval/decided` |
| 放行后假工具真的执行了 | ok |

---

## 2. 我创建的文件(精确路径)

全部新建,**没有修改任何已存在文件**。`git status` 里除我这两个目录外的改动都属于其他实现者。

| 路径 | 说明 |
|---|---|
| `frontend/scripts/host-integration/host-env.mjs` | 隔离契约:`DSH_HOME` 临时根、凭据变量剥离、端口试探、脱敏(含运行期发现的 token/cookie) |
| `frontend/scripts/host-integration/start-host.mjs` | 起真 pinned 宿主:写 `--patch` overlay、抓 launch token、换签名 cookie、等 `/api` 就绪 |
| `frontend/scripts/host-integration/fake-harness-plugin.mjs` | Cordis 插件:假 LLM adapter(`agos-fake`)+ 假工具(`agos_fake_action`),经 `tools/pre-execute` 返回 `kind:'ask'` 触发真审批 |
| `frontend/scripts/host-integration/ui-server.mjs` | Vite dev server 提供真 SPA,`/api` 反代到宿主并注入 cookie / 改写 `Origin`+`Host` |
| `frontend/scripts/host-integration/probe-host.mjs` | **B1** 线协议探针(不碰浏览器) |
| `frontend/scripts/host-integration/cleanup.mjs` | 收尾器:按 harness 独有标记回收孤儿宿主与临时目录 |
| `frontend/tests/host-integration/harness.mjs` | 一次运行的装配:宿主 + SPA + Chrome,每场景独立 page,真 store 读取器 |
| `frontend/tests/host-integration/scenarios.mjs` | 九个场景(bring-up + 任务书八条) |
| `frontend/tests/host-integration/run.mjs` | 运行器:`--only`、真实退出码、`results.json`、信号兜底 dispose |
| `frontend/tests/host-integration/artifacts/**` | 最后一次真实运行的证据(截图 / 日志 / JSON) |
| `docs/engineering/agos-round2-20260908/wiring/B-wiring.md` | 本文件 |

沿用上一轮 `frontend/scripts/hardening-ui-smoke.mjs` 的环境变量约定:
`AGOS_PLAYWRIGHT_MODULE`、`AGOS_BROWSER_EXECUTABLE`(另加 `AGOS_DSH_BIN`)。
`playwright-core` 与 Chrome 都是**只读复用**既有安装,没有下载、没有安装任何包。

---

## 3. 每个场景到底验了什么

四列 real 的含义:宿主是真 pinned `dsh`;浏览器是真 Chrome;传输是真 `/api` + `/api/remote.mux`;
store 是页面里那个真的 `live.ts` 单例(通过 `page.evaluate` + `await import('/src/stores/live.ts')` 读取,
Vite 同 URL 同实例,**只读不注入**)。

| # | 场景 | 宿主 | 浏览器 | 传输 | store | 测试自己动了什么 | 断言 | 结果 |
|---|---|---|---|---|---|---|---|---|
| 0 | bring-up:SPA 起、连上、转 live | 真 | 真 | 真 | 真 | 无 | 7 | **PASS** |
| 1 | 审批请求 → HTTP `accepted` → 宿主决定到达 | 真 | 真 | 真 | 真 | 无(自然时序) | 9 | **PASS** |
| 2 | 宿主决定**先于** HTTP 响应返回(时序竞争) | 真 | 真 | 真 | 真 | 把**真**响应扣住;请求/响应字节都是宿主自己的 | 7 | **PASS** |
| 3 | 失败后重试 | 真 | 真 | 真 | 真 | 第一个 POST 在传输层 abort(宿主根本没收到) | 8 | **PASS** |
| 4 | 切会话后旧会话的迟到回复被拒 | 真 | 真 | 真 | 真 | 两个真会话两个真 waterfall,A 的**真**响应扣到切换之后 | 9 | **PASS** |
| 5 | 连接 `ready`/`follow` 断开与重连 | 真 | 真 | 真 | 真 | 用 `close()` 关掉页面自己的 mux socket(不替换传输) | 11 | **PASS** |
| 6 | 空开窗仍暴露更早历史(分页不被藏) | 真 | 真 | 真 | 真 | 6a 无注入;6b 在**传输途中**把开窗快照的 `records` 清空(保留宿主自己的 `hasMore`) | 9 | **PASS** |
| 7 | 分页与实时尾部并发合并 | 真 | 真 | 真 | 真 | 无(真 `session/page` 与真实时轮次故意同刻发出) | 6 | **PASS** |
| 8 | 历史轮次证据不泄漏进最新一跳 | 真 | 真 | 真 | 真 | 无 | 8 | **PASS**(有范围限制,见 §7.4) |

几条值得单独看的证据(全部摘自 `artifacts/results.json`):

- **1**:终态是 `ApprovalPanel` 消失、结算审计行出现 `已放行(一次)`,宿主侧 `session/follow` 上恰好 **1 条** `approval/decided`。
- **2**:扣住期间 store 已 `resolved`,迟到的 200 回来后决定**没变**;相位时间线 `["gone","idle","pending","gone"]`
  里**没有任何**在决定之前就自称 `已放行` 的相位。
- **3**:`attempts=1` abort → UI 显示可重试文案 `审批提交未获确认,可重试:Failed to fetch`,
  且**不**自称放行;重试 `attempts=2` 后拿到 `allowed-once`,宿主侧仍然只有 **1 条**决定。
- **4**:A 被真实决定(1 条),B 在宿主侧只有 `["approval/policy","approval/asked"]`——**没有**决定;
  用 B 的 session 去读 A 的 `callId` 被当作外来项拒掉。
- **5**:订阅者收到的相位序列 `["online","offline","connecting","online"]`,3 个 mux socket 真的进入
  CLOSING/CLOSED、随后新开 3 个,并且**同一个 document**(见 §6.2 的坑)。
- **6**:30 个真实轮次让**宿主自己**回 `hasMore=true`(窗口 321 条记录);6b 空窗下横幅仍在、
  `加载更早的历史` 仍可点,点下去从真宿主捞回 50 条。
- **7**:窗口 50 → 64,64 个 id 全唯一(无重复),并发那条实时消息没被分页重建吃掉,31 个定位项 turn/step 单调。
- **8**:分页前后当前跳都是 `turn=30 step=1`,窗口 50 → 62 且最老轮次变成 1,跳位**没有**被历史轮次改写。

---

## 4. 需要控制者应用的生产代码改动

**没有。一处都不需要。** `frontend/src/**` 全程只读。

原因值得记一笔,因为它本来很可能需要一个测试钩子:
- 读真 store 不需要钩子——`page.evaluate(async () => (await import('/src/stores/live.ts')).conversationStore.getSnapshot(id))`
  在 Vite 下解析到的就是 `App` 用的那个单例;
- 定位不需要钩子——`[data-session-id]`、`.session-row-open[aria-current="page"]`、`.app-container`、
  `[aria-label="本跳证据"]` 这些生产选择器已经够用;
- 断开连接不需要钩子——初始化脚本只是**记住** app 自己创建的 `WebSocket` 实例(不代理、不替换、不伪造帧),
  测试对真 socket 调 `close()`。

---

## 5. 真实跑过的命令与退出码

| 命令 | 退出码 | 结果 |
|---|---|---|
| `node scripts/host-integration/probe-host.mjs` | 0 | B1 探针 11/11 |
| `node tests/host-integration/run.mjs`(最终全量) | **0** | **9 passed / 0 failed / 0 skipped**,74 条断言(运行器没有 skip 机制,所以 skip 恒为 0;一条断言都没被放过) |
| `node tests/host-integration/run.mjs`(前一次全量,复现用) | 0 | 9 passed / 0 failed |
| `node tests/host-integration/run.mjs --only 5-…` × 4 | 0,0,0,0 | 场景 5 稳定性压测 4/4 |
| `node scripts/host-integration/cleanup.mjs` | 0 | `0 process(es), 0 temp root(s)` |
| `npm run typecheck` | **0** | `tsc --noEmit` 干净 |
| `npm test` | **0** | tests **366**,pass **365**,fail **0**,skipped 1 |

`npm run build` **没有跑**(按约定归控制者)。没有 `git commit/checkout/reset/stash/clean/restore`。
没有重启、杀死或改配置用户正在跑的 DSH,没有写入 `~/.dsh/profiles/{desktop,web}`
(记录时 `web` 的 mtime 仍是 9 月 5 日 08:40)。没有读任何私有会话语料,数据全是合成的。

计数口径:场景数 9 = 任务书八条 + 一条 bring-up;断言 74 条是场景内部逐条 record 的检查,
不是 `node --test` 的 case 数。

---

## 6. 日志、截图、产物路径

根目录:`frontend/tests/host-integration/artifacts/`

| 文件 | 内容 |
|---|---|
| `results.json` | 机器可读全量结果:每场景的 `exercises` 标签(哪层是真的)、逐条断言、耗时、宿主退出码 |
| `run.log` | 运行日志(写盘前脱敏) |
| `host.log` | 真宿主 stdout/stderr(脱敏)。头部记录命令、cwd、`DSH_HOME`、被剥离的 24 个凭据变量名。**追加模式**,含本轮多次运行 |
| `probe-host-findings.json` / `probe-host.log` | B1 探针证据 |
| `0-bringup.png` … `8-history-evidence-does-not-leak.png` | 九张终态截图,真 Chrome 真 SPA |
| `superseded/*-failure.png` | **调试过程中**的失败截图,故意留档;它们不属于最终运行,别当现状读 |

脱敏:launch token 与签名 cookie 在**发现的那一刻**就注册进脱敏表,`host.log` 里只剩
`http://127.0.0.1:39411/?token=[REDACTED]`。凭据变量的**名字**入档、**值**从不入档。

截图本身就是"假模型 + 真宿主"的自证:每张图右下角的模型选择器都显示 `AgOS Fake Model / agos-fake`,
左侧会话列表里是宿主真实创建的 `scenario-*` 会话,右上角是 `已连接`。
`1-approval-accepted-then-decision.png` 里可以直接看到结算后的审计行 `审批 agos_fake_action:已放行(一次)`。

### 6.1 我自己抓到的第一个坑:场景间污染

`page.routeWebSocket` 没有 unroute,场景 6b 的"清空开窗 `records`"因此**活到了 7 和 8**——
证据是场景 7 当时打的是 `0 → 52 items` 而单独跑是 `50 → 64`。修法是每场景一个全新 page(`resetPage()`)。
**如果没发现,7 和 8 的"通过"是在被污染的窗口上得出的,不算数。**

### 6.2 第二个坑,更要命:页面刷新冒充重连

场景 5 最初"通过"过,但那是假的。`dropOpenSockets()` 当时关掉了**所有** socket,
其中包含 Vite dev server 自己那条;Vite 客户端一断就**刷新页面**。刷新后 store 是全新的、
socket 是全新的、一切"看起来恢复了"——而这与传输重连毫无关系。

坐实的过程:先加订阅者轨迹,再加页面内 5ms 采样器,两者都 30 秒看不到任何非 online 相位;
逐个 socket 同步读 `readyState` 才看清 `close()` 本身是好的(1 → 2 → 3),问题在关错了对象。
现在 `dropOpenSockets('/api/remote.mux')` 只关 app 自己的传输 socket,并且断言
`documentAlive`(记录器还在 = 没换 document)与"新 mux socket 确实开出来了"。
修完 4/4 稳定,相位序列是真的 `online → offline → connecting → online`。

### 6.3 第三个坑:孤儿宿主

调试期崩掉的运行漏了两个宿主进程(39411/39412)和 6 个临时目录。已按 pid 杀掉、目录删净、端口验空。
根因是硬中断绕过了 dispose;现在 `run.mjs` 挂了 `SIGINT/SIGTERM/SIGHUP` 兜底 dispose,
并补了 `cleanup.mjs`(只匹配 harness 独有标记 `agos-host-integration-home-…/agos-harness-overlay.json`,
**不可能**误伤用户自己的 `dsh`)。收尾复核:无残留进程、无残留临时目录、39411–39414 全空。

---

## 7. 未解决的风险与明确不接受的部分

### 7.1 SPA 是 dev server 提供的,不是发布构建(**不接受把本轮当成产物验收**)
真源码、真组件、真 store,但经过 Vite dev 变换。生产 `dist` 归控制者,我按约定没跑 `npm run build`。
**结论只覆盖到源码层,不覆盖打包产物**(minify/treeshake/生产条件编译的差异未验)。

### 7.2 `/api` 中间有我自己的一跳代理
浏览器信任栅栏要求 `Host`/`Origin` 属于受信 authority,且每个 `/api` 请求带宿主签发的签名 cookie。
Vite 代理负责改写头并注入 cookie。**协议帧是宿主的原件**,但"浏览器直连宿主"这件事本轮没有验证。
真实部署若不经同源代理,栅栏行为需要单独验。

### 7.3 模型与工具是假的(**这是刻意的,也是硬限制**)
只注册了 `agos-fake`,零付费调用。因此:真实模型的流式细节、长文本、工具参数多样性、
真实 provider 报错分支**都没有被覆盖**。审批/传输/分页这些被测语义与模型无关,所以这个取舍成立;
但任何"模型行为已验证"的说法都**不接受**。

### 7.4 场景 8 的证明范围比标题窄(**必须看清**)
stock 宿主没挂 `/api/turn-evidence/*`,证据条渲染成 `本跳证据未采集:HTTP 404`。
所以场景 8 坐实的是:**分页进历史轮次不会改写当前跳的 turn/step 定位**(30/1 前后不变,且始终等于窗口最大轮次),
并且证据条没有点名被分页进来的历史轮次。
**没有**坐实"有内容的历史证据不会串进最新一跳"——那需要一个真的会产证据的宿主插件(C/D/F 的地盘)。
建议控制者在 turn-evidence 插件挂上后补一轮。

### 7.5 用户自己的 `~/.dsh/profiles/web` 起不来(既存问题,与本包无关)
```
$ dsh web --help
Error: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include):
duplicate loader entry id: browser
```
只读复现,**没有改动它**。本包用的是隔离 home 里由模板新建的 profile,所以不受影响。
控制者若要在用户 profile 上做验收,得先修这个重复 `browser` 条目。

### 7.6 观察:AgOS 每条逻辑流各开一个 socket
bring-up 实测页面开着 **4 条** `/api/remote.mux`。`UPSTREAM.pin` 的措辞是"单条 socket 多路复用逻辑流",
而 `api-client` 注释写的是"AgOS 每 socket 一条逻辑流(最简可用子集)"。两者不冲突但容易误读,
且连接数随会话/工作区订阅增长——建议控制者确认是否要收敛成真正的单 socket 多路复用。

### 7.7 稳定性口径
全量套件连续两次干净通过,场景 5 单独压测 4/4。**这不等于长期无 flake**:
时序类场景(2/4/7)依赖真实调度,单机单次运行不足以给出 flake 率。CI 化前建议连跑 10 轮取统计。

### 7.8 顺手发现的一个文案矛盾(功能没坏,但会误导用户)
`6-empty-window-still-pages.png` 里,空开窗同时渲染了两句互相打脸的话:

- 空态主文案:`空白会话——在下方输入第一条指令。`
- 上方历史横幅:`当前窗口不是完整会话,还有更早的历史。 加载更早的历史`

分页affordance**没有**被藏起来(这是场景 6 要验的,通过了),但空态主文案把一个**有历史**的会话
说成了"空白会话"。属于文案/优先级问题,归 `frontend/src/**` 的负责人;我按规则**没有改**,只报告。

### 7.9 其它
- `host.log` 是追加的,读的时候注意分辨是哪一轮(按 `# command:` 头分段)。
- harness 硬编码了本机路径(`dsh`、`playwright-core`、Chrome),已用环境变量可覆盖,但换机需要重新指。
- 我这两个目录里的 `.mjs` 不在 `tsc` 覆盖范围内,类型安全靠约定而非编译器。
