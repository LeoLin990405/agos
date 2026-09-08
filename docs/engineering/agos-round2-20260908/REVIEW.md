# 本轮发现与处置

主控单写。进行中：两名独立审查者与验证者的结论未到齐前，**本文件不构成验收结论**。

## 独立验证者的发现与处置（2026-09-09，[VERIFY-FINAL.md](VERIFY-FINAL.md)）

最终验证门此前**一次都没跑过** —— 首次派发的验证者因模型区域限制直接报错退出，主控当时误以为它在运行。
重开后它复算出 930/927/0/3 逐格吻合、10 条命令退出码全对、`cn-capabilities` 连跑 5 次与 router 连跑 3 次
零离散，并确认主控列的 7 条反证全部按其声称报红。但它**判交付表述未过**，给了 4 项阻塞与 6 条新发现。

### 两条打在主控自己防线上的新发现（都已修并反证）

**N1／P2-7：计数下限门是 fail-open 的。** 挪走 `scripts/acceptance/expected-counts.json` 之后，
被清空的测试套件判 `PASS`、整个闸退出 0，只打一行告警。这道门的**全部**职责就是抓
「删测试把闸弄绿」，而删掉它自己的基线就能解除它。验证者指出的不对称是关键：
同一份代码对缺依赖是明确 fail-closed 的（`missing-host-modules` 判失败、退 78、绝不降级成 skip），
设计意图本就是「不确定就报红」，唯独这一路走了相反姿态。

已改为 fail-closed：缺基线文件直接退 78 并给出重建命令；`--floors=none` 是**显式**逃生阀
（首次引导基线时需要），会打印醒目的「本次运行不设下限」。三向反证：
挪走基线 → 退 78；`--floors=none` → 可跑但自报无下限；基线在位 + 清空测试 → 退 1，
报 `test-count-regression: tests 1 < floor 4`。

**P2-8：抗碰撞修复可被「削弱而非移除」绕过。** 不动任何生成点，把 `randomInt(0, 1_000_000)`
改成 `randomInt(0, 1)`（恒返 0，零随机性，同毫秒必然重名）—— 原缺陷 **100% 复活**，
而全套件当时 6/6 全绿。原因是主控写的源码扫描**见 `randomInt` 就跳过**（把「有随机尾」
当成「已修」），而唯一的行为断言只在两次写恰好落在同一毫秒时才施压。
验证者还实测出扫描看不见**双引号**拼接形状，而主控在 VERIFICATION.md 里写了
「与语法形状无关」—— 又一次说得比代码做到的强；那次双引号实验报红的其实是
「至少 4 处 `planFileName()` 调用」这条负控，不是扫描本身。

已补三层：扫描覆盖模板字面量 + 单引号 + 双引号 + 反引号四种形状；
对随机尾的**熵**下断言（上界须 ≥ 1e6）；并钉住 `padStart` 位数与上界一致。
三向反证：`randomInt(0,1)` → 报 `随机尾上界只有 1,熵不足以抗同毫秒碰撞`；
新增第五个双引号生成点（四处调用仍在、负控不响）→ 被扫描本身抓到；
`padStart(3)` → 报位数与上界不匹配。

**这两条合起来是本轮最值得记的教训**：主控的反证方向一直是「把修复**移除**」，
而攻击者（或未来的自己）更可能「把修复**削弱**」或「解除守卫本身」。
前者留下明显的 diff，后者不留。

### 四项阻塞（全部文档/卫生级，已逐条修完）

1. **`acceptance-gate.txt` 声称是 `--with-frontend` 输出但实物没有前端闸**，`logs/acceptance/` 为空——
   本轮从未捕获过任何 `--with-frontend` 运行。已按文档所述**真跑一次**并重新捕获，
   `frontend-verify` 闸现已在日志中可见，实测 927/0/3（930 测试），与文档声称的数字一致。
   顺带把前端闸也纳入计数下限（`frontend-verify: minTests 366 / minPass 365`）。
2. **同一日志做了脱敏却无声明**，与 VERIFICATION.md「这两个文件都在文件头第一行注明」直接矛盾。
   已补声明，并把口径统一成「七个文件全部经过同一套替换」——原先「其余五个未经处理」的说法也已校正。
3. **本轮新增交付文件里 28 处个人绝对路径未被忽略。** 分四类处置：
   `scripts/acceptance/artifacts/` 新建 `.gitignore`（同联测产物的处理）；
   `dependency-surface.json` 在**写盘这一层**做占位符替换（它的 `errorExcerpt` 是子进程报错原文，
   必然带绝对路径，靠「记得脱敏」挡不住，所以放在唯一的出口而不是各个采集点）；
   `host-env.mjs` 的两个默认值改为从 `homedir()` 推导；交付文档统一 `/Users/<name>` 占位。
   实测：交付文档与最终日志个人路径命中 0，产物目录 `git check-ignore` 生效。
4. **`TASKS.md` 的「3 处／5 项」是中途数字**（实际 4 处／6 项）。「3 处」恰是接线审查者发现
   漏修第四处**之前**的那个数——那份表当时记录的是一个已知不完整的状态，却读起来像终态。已校正并留校正记录。

### 六条 P3 的处置

| 项 | 处置 |
|---|---|
| P3-1 `dsh-agos-router` 套件非结构自足（裸跑仍读操作者 `~/.dsh/logs/fleet/runs.jsonl`） | 未修，已在 harness 缓解并如实披露；列入下一轮 |
| P3-2 第四个接线点（`transact` 注入）仍无直接覆盖 | 未修（本轮已补 thenable 闸约束误用方向）；已在 HANDOFF 登记 |
| P3-3 `acceptance-gate.txt` 含 macOS 用户级临时目录标识 | **已修**：重新捕获时增加 `<TMPDIR>` 替换，实测仅剩我自己解释这条问题的那句 prose |
| P3-4 `plugins/dsh-mcp-bridge/mcp.test.mjs` 是 `test/mcp.test.mjs` 的字节级重复（md5 相同） | **已修**：删掉散落那份；闸只 glob `test/*.mjs`，删后仍 4/4 |
| P3-5 `DEPENDENCIES.md` 风险编号顺序 1、2、3、**5**、**4** | **已修**：恢复为 1、2、3(已作废)、4、5 |
| P3-6 任务书给的 `scripts/acceptance/contract-baseline.sha256` 不存在 | **已修**：改用真实路径 `frontend/contract-baseline.sha256` 复核，见 VERIFICATION.md；原检查是空洞的 |

### 一处正面确认

验证者复核了主控主动登记的「第四个接线点（`transact` 注入）至今无覆盖」，实测为真
（改成直通后仍 124/124 全绿）。那是一处没人要求写、对自己不利的披露，内容与事实完全相符。


## 契约研究（只读，未启停任何宿主）

针对 pin `deepseek-harness @ a66e470204 (0.1.2-rc.1)`，逐条对着**已安装宿主源码**核对，不据字段名推断。结论按 `confirmed / partially-confirmed / unconfirmed` 标注。

### 隔离启动（B 包的前置阻塞项）

| 问题 | 结论 | 置信度 |
|---|---|---|
| 有没有「绝对路径 profile 目录」参数 | **没有**。只有 `--profile <name>`，恒定解析到 `$DSH_HOME/profiles/<name>`（`dsh-app-boot` 的 `resolveProfileDir` 明确拒绝含 `/` 的名字） | confirmed |
| 如何不改 `HOME` 而隔离状态 | 用 **`DSH_HOME`** 整体搬迁 harness 家目录（`dsh-home-paths` 的 `resolveDshHome` 读该环境变量，缺失才回落 `~/.dsh`） | confirmed |
| `--port` 与默认端口 | `--port` 存在，`0` 表示由 OS 选；web 组合默认 **3080**。用户 `desktop`/`web` 两个 profile 的 `cordis.patch.yml` 都没有 `port:` 覆盖 | confirmed |
| 有没有一条开关能零模型启动 | **没有单一 CLI 开关**。`@deepseek-ai/dsh-llm-replay` 与 `dsh-llm-mock-server` 只在 CLI 的 `devDependencies` 里声明，已安装树中不存在 | confirmed（不存在）|

B 包实测已越过这一条：真实宿主跑在隔离 `DSH_HOME` + 39411 端口，并通过 `--patch` 覆盖层做到 `providers=["agos-fake"]`（不存在付费路由）。**实测优先于研究者的 `unconfirmed`** —— 研究者只是没找到现成开关，B 用覆盖层达成了同一目标。最终认定以 B 的证据链为准。

### UPSTREAM.pin 的传输层声明逐条核对

`client-request`/`server-response` 双信封、错误 `{code,message,details}`、unary `{args:{<paramName>:value}}`、单条 `/api/remote.mux` 多路复用 `session/follow`+`workspace/follow`+`$events`、Host→Client 经 `$events/result` 应答、`session.history`→`session/page`+`follow`、`session.models`→`session/modelCatalog`（零参数）、`host.describe` 已移除且 home 走 `$events` ready —— 以上**全部 confirmed**，均有宿主源码位置与代码片段支撑。

唯一需要修订措辞的是 `workspace.list`→`workspace/follow`：**`workspace/list` 在宿主上根本不存在**（workspace controller 只有 create/rename/delete/insertBefore/insertSessionBefore/archiveSession/follow）。另有一个 `directoryPicker/list` 属于 `directoryPicker` 命名空间，容易被误当成 workspace 的 list。标为 partially-confirmed。

### 批准协议的顺序保证（B 包场景 2 的判定口径）

宿主对某个 `eventId` 的 waterfall 结算发生在 `dispatchRpc` 处理 `$events/result` 的**同步链内**，因此**在 HTTP `server-response` 返回之前**完成 —— confirmed。

但要分清两件事：`approval/decided` 追加到会话日志后，**经 `session/follow` 流被观察到的时刻**与 HTTP 响应返回的先后**没有保证**。所以「宿主决定先于 HTTP 返回」这一条，作为 waterfall promise 的结算顺序是成立的，作为「follow 流先于 HTTP 可见」则是 unconfirmed。B 的对应测试必须按前者立断言，不能按后者。AgOS 前端本来就写明了 `POST accepted is not host authorization`（`frontend/src/stores/live.ts`），口径一致。

### AgOS 侧契约漂移（研究者提出，主控复核）

| 编号 | 内容 | 主控复核结论 | 严重度 |
|---|---|---|---|
| F1 | `sessionModelCatalogRequestSchema` 要求 `sessionId`，而宿主 `session/modelCatalog` 是零参数 | 成立。`frontend/src/api-client/index.ts` 的 `ARG_KEY` 是 `null`，线上调用是对的；但 `frontend/src/contract/api/sessions.ts:225` 的类型面与 `stores/live.ts:760` 的 `{ sessionId: sessionId as never }` 都在传一个会被丢掉的参数。`as never` 强转就是这处不一致的味道。**模型目录在线协议上并非按会话隔离**，AgOS 的类型面却当它是 | P2 |
| F2 | `ModelSelector.tsx` 注释仍写 `session.models` | 成立，纯注释 | P3 |
| F3 | AgOS 侧仍在调 `/api/host.describe`，而该方法在 0.1.2 已移除 | 成立，且主控复核后**上调为 P1**：真实后果比「attached 恒为未采集」严重得多，见下方 I4 | **P1** |
| F4 | AgOS smoke 默认 `3091`，宿主默认 `3080` | 成立，属约定差异，隔离启动时容易踩 | P3 |

### 主控修正研究者的一处结论

研究者称 `@deepseek-ai/dsh-tools` / `dsh-llm` 的 registry 版本是 `0.0.1-rc.1`、与已装的 `0.1.2-rc.1` 不符，因此「从 registry 复现存疑」。**这一条不成立**：研究者只查了 `latest` tag。主控直接实测 `npm view @deepseek-ai/dsh-tools@0.1.2-rc.1 version` 返回 `0.1.2-rc.1`，并**实际安装成功**，`npm ci` 亦可复现。registry 的 `latest` tag 停在旧版是真的，但精确版本是发布可取的。真正不可从 registry 复现的只有 `dsh-kimicode-swarm` 一个包 —— 依据与逐层证据见 [DEPENDENCIES.md](DEPENDENCIES.md)。

## 整合期发现

### I1（曾为 P1，已由 C 自行解决；保留记录）Router 新 ID 形状一度破坏前端契约

C 包要修的缺陷是真的：`asm-${Date.now()}` / `dsp-${Date.now()}` 在同一毫秒内会重复（两个浏览器标签、一次重试、脚本循环、两台机器共享 `~/.dsh`），重复 ID 会把两条不同记录静默合并 —— 后一条试跑的 turn 被算到前一条提案上，且事后下游无从察觉。

**主控在中途快照里捕获到一次跨界破坏**：C 的中间版本给三种前缀都用了 hex 尾，而前端 `frontend/src/components/console/routes-assemble.ts:131-132` 的形状校验是 `/^asm-\d{1,20}$/` 与 `/^dsp-\d{1,20}$/`，新 ID 通不过，`parseAssemblePlan` 取不到 `id`，界面落到「提案编号未采集，无法指定试跑对象」。实测当时前端 `npm test` exit 1、366 个测试 362 通过 / 3 失败 / 1 跳过（纯净 `7e7e359` 是 exit 0、365/0/1），三个失败集中在 `src/components/console/routes-assemble.runtime.test.ts`。

**C 随后自行解决，且做法比单纯放宽前端正则更稳**：按前缀分两种尾编码。

| 前缀 | 尾编码 | 随机强度 | 理由 |
|---|---|---|---|
| `dec-` | `-<hex 8..64>`（128 位）| 128 位 | 插件内部使用；仍匹配 `shadow.js` 的 `DEC_ID_RE` 与 `sanitize.js` 的 `DECISION_ID`，两处均无需改动 |
| `asm-` / `dsp-` | 紧接时间戳的 7 位数字，不加连字符 | 约 23 位 | 是与控制台的**已发布契约**；`postAssembleDispatch()` 在提案 ID 校验失败时**根本不发请求**，hex 尾会直接让试跑按钮失效 |

13 位时间戳 + 7 位随机 = 恰好 20 位，正落在前端既有的 20 位预算内。C 把强度差异**如实写明而没有向上取整**：asm/dsp 只有在同一毫秒内**且**抽到同一个千万分之一尾数时才会碰撞 —— 这消除了「同毫秒必然同 ID」的确定性，而那才是原本的缺陷。

主控复测：前端 `npm test` **exit 0、366 个测试 365 通过 / 0 失败 / 1 跳过**，与纯净基线一致。**因此前端 `src` 本轮无需改动**，我原先准备的正则放宽没有实施。

未决的取舍留给接线阶段：C 在 `C-wiring.md` 里提供了一份放宽前端正则的 apply-ready diff，可让 asm/dsp 也用满 128 位尾。放宽前端归主控所有权。判据是「23 位是否够」而非「能不能改」—— 决定与依据在接线一节记录。

### I4（P1，本轮如实上报、不改代码）pin 宿主的 web profile 上会话删除被永久 503 挡住

主控顺着研究者的 F3 往下追，发现后果不是「attached 显示未采集」这种展示层退化，而是**一整个功能在 pin 宿主上不可用**。链条如下，每一环都已核实：

1. `host.describe` **在已装 pin 宿主里完全不存在**。研究者这条成立。

   ⚠️ **证据重做（2026-09-09）**。原先这句引用的是「对 `plugins/node_modules/@deepseek-ai/` 跑 `rg -l` 命中 0」，
   接线审查者（F 节末）指出该范围只是**插件依赖子集（24 个包）**，扫不到本文档自己引用的 `dsh-app-boot`/`dsh-home-paths`
   等宿主包 —— 一条 P1 的证据句不该引用扫不到关键对象的扫描。审查者随后报告自己对 194 包的 headless 树复扫「同样 0 命中」。

   主控复核时发现**那次复扫多半是无效的**：该目录下每一项都是指向 `~/.npm-global/...` 的**软链**，
   而 BSD `grep -R` 不跟进去。主控用同法先跑正控 —— `function`、`export`、`session` 这些必然存在的词在 592 个 js 文件里
   **全部 0 命中** —— 证明扫描本身是坏的，那个 0 不构成证据（无论谁跑的）。

   改用 `rg --follow` 重做，**正控先过**（`function` 命中 1141 个文件），结论不变：

   | 范围 | 包数 | 正控 `function` | `host.describe` | `attachedSessions` |
   |---|---|---|---|---|
   | `~/.dsh/profiles/headless/node_modules/@deepseek-ai/` | 194 | 1141 文件 | **0** | **0** |
   | `plugins/node_modules/@deepseek-ai/`（交付树） | 24 | 190 文件 | **0** | — |

   全树仅有的两处 `"describe"` 是 `dsh-api-remotes/lib/client.js` 里的
   `credentials/describe` 与 `settings/describe`（settings-controller 的方法），与 `host.describe` 无关。
   全仓唯一仍在调它的是 `plugins/dsh-agos/lib/index.js:428`。

   **教训记在这里**：这一轮里「命中 0」被当作证据用了不止一次。没有正控的 0 命中不是证据，是扫描失败与事实缺席的叠加态。
2. `attachedFromRpc()`（`lib/index.js:425`）对任何非 ok 结果一律返回 `{ available:false, attached:false }`。方法不存在 → 宿主回错误信封 → `result.ok !== true` → `available:false`。
3. `assertDetached()`（`lib/index.js:860`）**先查 `available`**，不可用就抛 `503 LIVE_STATUS_UNAVAILABLE 暂时无法确认会话是否仍挂载，未执行删除`。
4. 生产接线（`lib/index.js:1427-1428`）传的是真实的 `runningFromContext` / `attachedFromContext`。web profile 的 `ctx` 不公开 `sessions` 服务，因此必然落到第 2 步的 RPC 兜底。

**结论**：在 pin 对应的 web profile 上，`assertDetached` 永远不可能成功，会话删除**恒定返回 503**。

要把两件事分清楚：

- **不是安全缺陷，方向反而是最保守的那一侧。** 它拒绝删除，不是误删。fail-closed 在这里是强意义的：宁可不删，也不在「不知道会话是否还挂着」时动手。这个设计本身是对的。
- **是功能阻塞。** 用户在 web profile 上永远删不掉会话，且错误文案说的是「暂时无法确认」，暗示重试会好 —— 而它永远不会好，因为依赖的方法已经不存在了。文案把永久失效说成了暂时故障。

**并且这条路径是全仓唯一没有测试的那一支。** 所有测试都注入 `readAttached: async () => ({ available: true, … })`（`test/session-management.test.mjs:33` 等 10 处，`test/session-memory.test.mjs` 2 处），真实 RPC 兜底只在生产上跑过。也就是说：**决定「允不允许删除」的那段代码，恰好是唯一没被测过、且指向一个已被删除的宿主方法的代码。**

**本轮不改，如实上报。** 理由是不能猜：代码注释在 `lib/index.js:376` 写着「`running` 的权威定义就是 attached agent 的状态，由 session.list 暴露」，据此似乎可以用「会话是否出现在 `session/list` 里」来替代 attached 判定。但 `session/list` 的实现在 CLI 包里，不在隔离依赖树内，本轮拿不到它对「挂载」的确切定义；`session/list` 列出的到底是「已挂载」还是「宿主视野内（含冷会话）」，两种读法会导出相反的删除结论。本轮明确规定「不根据字段名猜测」，因此**不在猜测上改动一段控制删除许可的生产代码**。

主控尝试过对真实 pin 宿主直接取证：B 的隔离宿主在 39411 上确实在监听，但 `host.describe` 与 `session.list` 两个探测都返回 `unauthorized`。**没有绕过鉴权，也没有继续深挖 B 正在使用的宿主**，以免干扰 B 的测试。因此上述结论的性质要标清楚：**由「已核实的方法缺失」加「代码路径阅读」推导得出，不是一次动态宿主验收。**

解决它所需的实验写在 HANDOFF：在真实 pin 宿主上对一个已知挂载与一个已知分离的会话分别查 `session/list`，比对差异，确定「挂载」的权威判据；在此之前，至少应把 503 的文案从「暂时无法确认」改成能反映永久失效的说法 —— 那处改动也归主控，同样需要先有测试覆盖这条兜底。

### I5（夹具缺陷，非产品缺陷）B 的场景 8 在真宿主上超时，且失败姿态与产品失败不可区分

B 的真宿主联测确实是真的，不是拿组件夹具冒充：`artifacts/results.json` 里每个场景都自报 `host=real browser=real transport=real store=real`，`hostExit.code=0`，截图里的模型选择器显示 `AgOS Fake Model / agos-fake` —— 付费供应商在那个隔离宿主上根本不可达。九个场景**全部通过**（`artifacts/results.json`，`at=2026-09-08T16:00:21.682Z`，`passed 9 / failed 0 / hostExit.code 0`）。

⚠️ **状态校正（2026-09-09，接线审查者 F1）**：本节以下按「场景 8 失败」写的内容是**原始故障记录**，已被 B 修复夹具后的重跑取代。三份文档原先对同一件事给了三种状态（本节「8 通过 1 失败」、HANDOFF「九个场景全部通过」、HANDOFF 待办里「场景 8 夹具修复与重跑」未打勾），读者无法判断哪个是终态。以产物为准：终态是 9/0。

**场景 8 到底证明了什么（比标题窄，这一点仍然成立）**。主控核对了 `run.log` 里它实际执行的每条断言：

```
ok   hop after paging: turn=30 step=1
ok   the current hop is unchanged by paging in historical turns
ok   the hop still names the newest turn, not a historical one (30 === 30)
ok   the evidence strip does not name a paged-in historical turn:
       轮次 30 · 步骤 1 本跳证据未采集 本跳证据未采集：HTTP 404
```

前三条是**实打实的**：翻入历史轮次后当前跳的身份没有被改写，仍指向最新轮次。第四条也确实执行了（证据条渲染出来了，不是 `strip.count() === 0` 跳过），但它是在证据条**如实自报「未采集：HTTP 404」**的状态下通过的 —— 也就是说这一跳压根没有证据内容可供泄漏，「不串到最新一跳」在这次运行里没有被真正施压。顺带得到一个正面结论：证据采集失败时前端走的是 fail-closed（显示「未采集」），没有拿旧证据顶包。这与 B 自报的「证明范围比标题窄」一致，不是事后找补。

**I5 要求的「`blocked` 与 `fail` 分开报」未落实**：主控查过 harness，`run.mjs` 的状态词汇只有 `pass`/`fail`，全仓没有 `blocked`。所以「证据采集 404 导致该子断言无从施压」这件事，在 `results.json` 里与一次真正的通过不可区分 —— 只有读 `run.log` 的断言文本才看得出来。列为下一轮 P2。

失败的是 `8-history-evidence-does-not-leak`：`Error: host-integration: timed out waiting for a current hop position from the real store`，55 秒超时于 `frontend/scripts/host-integration/host-env.mjs:155`，只有第一个检查通过（「真宿主窗口确实被截断，因此有更早的 turn 可以分页进来」）。

主控看失败截图定位到根因，**这是夹具缺陷，不是产品缺陷**：页面当时处于**空窗口**状态 —— 正文是「空白会话——在下方输入第一条指令。」，底部状态行是「本跳编号未采集」，而截断横幅「当前窗口不是完整会话，还有更早的历史。加载更早的历史」确实在（分页前置条件成立）。也就是说：这个会话有更早历史可分页，但**当前窗口里一条 turn 都没有**，因此不存在「当前跳」供 store 发布，`waitFor` 在等一个永远不会成立的条件。「本跳编号未采集」正是产品拒绝编造的诚实降级，本身没有问题。

顺带说明：这条结论出自一张截图加错误堆栈的判读，主控**没有复现**，已要求 B 先证伪再动手。

要真正测「历史 evidence 不串到最新一跳」，必须先有一个「最新一跳」供它串进去：先在当前窗口发一条 turn 并等到 store 发布跳位置，记录该跳的 evidence，**再**分页拉入更早历史，最后复查该跳的 evidence 未变、且分页进来的旧 turn 的 evidence 没有被归到它名下。按现在的次序，这个场景只可能超时，不可能真正断言成功或失败。

**同时要求 B 修一个更要紧的问题**：夹具超时与产品断言失败在 `results.json` 里目前是同一个 `fail`，不可区分。前置条件不满足时必须报成 `blocked` / `precondition-unmet` 这类独立状态。信号混在一起时主控不能签验收 —— 一个只反映夹具超时的绿灯，和一次真实的产品失败，价值相反。

### I6（P1，已修并加测试）主控接线在测试上完全裸奔

主控应用 C 的接线后先问了一个问题：**有没有测试能抓到我漏接线。** 答案是没有。

把 `plugins/dsh-agos-router/lib/index.js` 里的 `withLedgerLock` 换成直通 `(_f, fn) => fn()`，全套件仍然 **116/116、exit 0**。也就是说锁原语被 C 测得很足（真多进程、真 SIGKILL），但没有任何测试验证生产入口的五个读改写调用点**真的用了它**。漏接、或者事后被谁删掉，都不会有一条测试变红。这正是本轮明令禁止的「只审 helper、不审 index.js」。

主控因此新建 `test/index-transaction.test.mjs`（4 项）。判据选的是「外部进程持锁期间生产路由是否被挡住」，而不是往临界区注入延迟去赌竞争窗口 —— 真实跨进程文件锁被别人持着时，接了线的调用必须等到释放才能返回，「等到了」就是接线存在的运行时证据。

**中途踩到一个自己造的假阳性，值得记下来**：`recordOutcome` 那条最初也用「是否被挡住 500ms」判定，反证时**它照样通过**。原因是 `ledger.js` 的 `appendLine` 自己就会取锁，所以即便完全没接线，也会在追加那一刻被挡住 500ms —— 那个计时量到的是 `appendLine` 的锁，不是事务边界。改成考「读的位置」才有区分力：让持锁的子进程在持锁期间先落一条 `ok`，然后主进程用 `fail` 去记。接了线，读在锁内、必然看到 `ok`、冲突被拒；没接线，读在锁外、看不到它，于是台账里出现两条互相矛盾的 outcome。

反证结果（在 `/tmp` 镜像上做，仓内未改）：

| 反证 | 结果 |
|---|---|
| 接线全部改直通 | exit 1，**三条全红**：`只等了 0ms`（shadowLink）、`只等了 1ms`（backfillShadow）、`台账里出现了 2 条 outcome`（recordOutcome）|
| 无人持锁时跑同一批（负控） | 全绿，`GET /routes` 仅 26ms —— 证明上面的等待确实来自外部持锁，而不是这些端点本身慢；同时证明同进程嵌套取锁不自锁 |

**仍未覆盖的第四个接线点**：`dispatchLiveRequest` 注入给 `dispatchTeam` 的 `transact` 依赖。隔离反证确认 —— 单独删掉那一行，全套件 **120/120、exit 0**。`test/dispatch.test.mjs:295` 证明的是「`dispatchTeam` 会用注入进来的 `transact`」，不是「`index.js` 真的注入了它」。要覆盖它得先跑通三条模型流（需要真实 `ctx.llm`），不在合成范围内。缺口已写进测试文件头部注释，不让后来者因为该文件全绿就以为四个点都守住了。

### I7（P1，主控自查时发现并修复）计划文件名同毫秒必然重名

整合期主控把 `cn-capabilities` 全套件连跑三遍，得到 108/0、108/0、**107/1** —— 一个靠运气通过的抖动。红的那次是：

```
✖ production approval does not relabel inherited parent events as current-session approval
  AssertionError: The input did not match /未执行/.
  Input: '❌ 计划保存失败: plan file already exists'
```

根因：`cn-capabilities/lib/index.js` 的计划文件名是 `PLAN_DIR + '/plan-' + Date.now() + '.json'`，**同一毫秒内建两份计划必然重名**。这和 C 修的 `asm-`/`dsp-` 是同一类缺陷：把时钟当唯一身份。

先说清两件不是问题的事：测试用的是 `mkdtempSync` 临时目录，**没有写进任何个人目录**；`writePlanObject` 的 `create: true` 是 fail-closed 的，重名时报错而**不覆写**别人的计划，那道闸是对的。真正的后果是用户侧的：一次完全正当的操作被时钟精度挡掉，界面只显示「❌ 计划保存失败」。

修法与 C 的取舍完全一致 —— **尾巴必须是纯数字**：`plan-path.mjs` 的 `PLAN_NAME` 是 `/^plan-\d+\.json$/`，而 `/api/cn/plans` 与 `plan_run` 的 `planFile` 参数共用这道闸，换成 hex 会让新建的计划**立刻通不过自己的路径校验**。`PLAN_NAME` 位数不限，所以接 6 位随机数字即可，契约一个字都不用动。生成点统一走新的 `planFileName()`。

⚠️ **校正（2026-09-09，接线审查者 C1）**：这里原先写「三处生成点统一走」，实际是**四处中的三处**。漏掉的 `lib/index.js` 的 `planFile = PLAN_DIR + '/plan-' + Date.now() + '.json'` 是**字符串拼接**写法，而主控当时按模板字面量 `plan-${Date.now()}` 的形状搜索，形状不同因而没命中。漏掉的恰是四处里后果最重的一处：它在 `plan_run` 带 `approve=true`、已过批准门、马上要执行那一步，同毫秒撞名会让**一次已获批准的执行**被时钟精度挡掉。已修，四处现已统一。

同时补了一条**不依赖语法形状**的防线：`test/plan-filename-collision.test.mjs` 新增「全生成点扫描」，直接对 `lib/index.js` 源码断言不存在把裸 `Date.now()` 拼进 `plan-` 文件名的写法（模板字面量与字符串拼接两种形状都抓），并带一条「至少 4 处 `planFileName()` 调用」的负控防止扫描指错文件。四处逐个回退反证：模板字面量形状两处、拼接形状一处均报红并在失败信息里点名该行。

`plugins/*/lib/index.js` 归主控，所以这处生产修复由主控做，并补 `test/plan-filename-collision.test.mjs`（5 项）：

| 测试 | 守住的东西 |
|---|---|
| 钉死时钟后连出 500 个文件名 | 时钟不再是唯一身份。**故意不断言「一个都不重」**——6 位尾在 500 抽里按生日问题约 12% 会撞一次，那样等于用一个每 8 次红一次的新抖动换掉旧抖动；断言的是量级（≥480 个不同），原实现在这里只会产出 1 个 |
| 新名字仍通过 `resolvePlanPath` | 随机尾不能把计划挡在自己的校验之外 |
| **负控**：hex 尾被路径闸拒掉 | 这就是尾巴必须是纯数字的原因，写成可执行断言而不是注释 |
| 重名时依然拒绝覆写 | 修身份不许顺手把 fail-closed 那道闸弄松 |
| **真实生产路径**连建两份计划 | 直接驱动 `apply()` 注册出的 `plan_run`，断言两份都落盘、文件名数字位数 > 13 |

反证：把 `planFileName()` 改回纯 `Date.now()`，最后一条立刻红并报 `只有 13 位数字(纯时间戳):lib/index.js 又退回 plan-${Date.now()} 了`。它是被**确定性的位数断言**抓到的，不是靠碰撞概率——两条断言同时写就是为了这个。修复后全套件连跑五遍，**5 × 114/0**，抖动消失。（校正：原先记的是 5 × 108/0，那五次发生在新测试文件加入**之前**，不是在交付树上取得的 —— 接线审查者 F2 指出这正违反同一句自己立的规矩。已在交付树上重跑，见 [VERIFICATION.md](VERIFICATION.md)。）

### I8（既存问题，本轮只读复现、未改）操作者自己的 web profile 起不来

B 在准备隔离宿主时顺手复现了一个与本轮改动无关的既存故障：

```
$ dsh web --help
Error: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include):
duplicate loader entry id: browser
```

即操作者 `~/.dsh/profiles/web` 的 loader 配置里 `browser` 条目重复，整棵插件树加载失败。B **只读复现、没有改动它**（执行边界禁止改生产配置），本包用的是隔离 home 里由模板新建的 profile，因此不受影响。

这一条与 I4 要分开看：I4 是 pin 宿主上 `host.describe` 已移除导致的代码问题，跟 profile 配置无关；I8 是操作者本机这一份 web profile 配置坏了。但两者叠加意味着**任何想在操作者自己的 web profile 上做验收的后续工作，都得先修这个重复 `browser` 条目**。

### I2（P2）插件声明的 schemastery 版本相对 pin 已过时

各插件 `package.json` 声明 `@deepseek-ai/schemastery: 3.18.1`，而 pin 的 `@deepseek-ai/dsh-settings@0.1.2-rc.1` 声明 peer `^3.18.2`，真实 web profile 实装 3.18.2。隔离依赖树按宿主取 3.18.2。插件声明本轮未改（属各实施者所有权范围），登记为漂移项。

### I3（P2）dsh-fleet 与 cn-capabilities 的失败姿态不一致

swarm 调度器加载失败时，`cn-capabilities` 给出明确中文错误并继续（`❌ 无法加载 swarm 调度器(dsh-kimicode-swarm):…`），`dsh-fleet/lib/index.js` 则在 import 期直接抛 `SyntaxError`。后者缺少同等的 fail-closed 降级，这也是它在 pin 对应 web profile 上装不起来却没有可读诊断的原因。

## 主控对各包的核验（独立于实施者自述，逐项实跑）

主控没有采信任何 agent 的自述结论，全部自行实跑并检查测试的**性质**（真子进程 / 真宿主 / fake / 静态），重点看有没有「跑了但什么都没断言」和「负例其实永远不会失败」这两类假绿。

### A 可复现依赖与验收入口 —— 通过

代码门与部署漂移**确实分成两条通道**：`advisory` 通道注明「真实退出码保留但**不参与**进程退出码」，`deploy-drift` 如实记 `exitCode: 1` / `verdict: fail` / `reason: nonzero-exit:1`，而 `processExitCode: 0` 由代码门决定。默认姿态也对：`corpusDirExists: false`（语料目录指向不存在的临时路径），`providerKeysCleared` 清掉了 `Z_AI_API_KEY` / `GLM_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`。

真正让主控认可这一包的是**它给验收夹具本身写了自测**：`node scripts/acceptance/selftest.mjs` exit 0，14 项全通过，且 13 项是负控 —— 证明这套闸抓得住各种作弊姿态。

| 负控 | 证明的事 |
|---|---|
| NC2 | 0 个测试 + 退出 0 → `empty`，不算通过，闸变红 |
| NC3a | 漂移退出 1 而代码门全绿 → 进程退出 0，但漂移的真实退出码没被吞 |
| NC3b | 零漂移救不了失败的代码门 |
| NC4 | 缺必需宿主包 → `fail` + `missing-host-modules`，不是 skip 也不是 pass |
| NC5a/b | 全 skip → `skipped`、pass 计 0、闸不绿；pass+skip 混合各归各位 |
| **NC6 / NC6b** | 测试数低于基线下限 → fail。**删测试骗不过闸**；而且把测试文件清空后 node 会把它算成 1 个通过 —— 只有下限闸抓得到 |
| NC7 | 默认把语料目录指向不存在路径并剔除供应商密钥 |
| NC8 | 朴素 `pipe+grep` 会把失败洗成 0，验收器不这么干 |
| NC9 | `--write-floors` 拒绝把红状态写成基线 |

NC6b 是本轮最锐利的一条发现，它点出了一个本来足以静默架空整个门的机制。

### C Router 持久化与反馈完整性 —— 通过

多进程一致性是**真并发**，不是模拟：`test/ledger-multiprocess.test.mjs` 真 `spawn` `node` 子进程对真实文件竞争，真 `SIGKILL` 打断写入，5 项全通过，其中两项耗时 1.96s / 1.83s，与真并发相符。覆盖：并发追加不丢已确认记录且不撕行；跨进程读改写只记一次 outcome、posterior 只计一次；写入中被 SIGKILL 留下的碎片永远解析不成功且不丢已确认记录；活锁 owner 不被偷、只回收死的、且不会从新 owner 手里回收；陈旧回收者不能删掉替代它的新 owner 的锁。

任务身份绑定 9 项，其中 **6 项是负例**：为任务 Y 算出的 verdict 对任务 X 的 decision 无效；完全不声明任务的 reviewer verdict 在 decision 有任务时被拒；跨任务试跑端到端什么都记不上且 posterior 保持空；重放提交被拒且重复不会重复计数；重放整次试跑不能为同一 decision 记第二个 verdict；同模型 reviewer 门仍然先于任务门触发。历史兼容也在：`checkTaskBinding leaves pre-taskRef history bindable and says so`。

诚实门 4 项，正对「不得把文本试跑标成真实仓库执行成功」：`a fully successful text-only trial is recorded as text-only, not as a repository run`、`turn success never becomes a decision outcome, a posterior observation, or a filled cell`、`the honesty fields are on the record itself, so no display layer has to infer them`（诚实字段落在记录本身，不依赖展示层推断 —— 这一条方向对）、`even a passing reviewer verdict books a judgement, never a repository execution`。

### D Linux 自动研究验证沙箱 —— 通过（Linux 未动态验收，如实标注）

能力检测是显式探测而非 `process.platform` 乐观判断，每次拒绝都点名缺哪一项：procfs、逐个 namespace、非特权 user namespace 的三个 sysctl（含 AppArmor 的 `apparmor_restrict_unprivileged_userns`）、`bwrap`/`unshare` 是否在 PATH、`unshare` 是否支持所有必需 flag、能否 bind `/usr`。

主控最认可的是**它自己拒绝把静态检查说成 OS 证据**：文件头明确写「本文件没有任何测试真的 spawn 过 bwrap 或 unshare，不得被当作 OS 隔离的证据」，测试名分 `STATIC:` / `DECISION LOGIC:` / `THIS HOST:` 三档，并有一项直接叫 `THIS HOST: the real probe finds no linux isolation, so the linux path stays unproven`。真实/静态分界与 macOS 侧七项真子进程覆盖见 [VERIFICATION.md](VERIFICATION.md)。

### E Fleet 远端产物路径竞争 —— 通过

11 项全通过。做法比要求的下限更强，也确实避开了「realpath 后另开文件」这个被明确禁止的姿态：

- **远端**（SSH shell，没有本地 fd 可用）：`runDirPrelude` 逐层 `[ -d X ] && [ ! -L X ]` 后 `cd` 进去再取 `pwd -P`，并要求 `[ "$tasks_phys" = "$workspace_phys/tasks" ]` —— 解析后的物理路径必须是上一层解析后路径的直接子级。`cd` 之后进程的 cwd 已经绑定到该目录的 inode（内核里 cwd 本身就是一个目录 fd），后续 `find .` 全部相对这个已校验的 inode，事后替换路径不会移动 cwd。这就是「校验与访问绑定到同一对象」在远端 shell 语境下的正确表达。
- **硬链接**：`find … -type f -links 1`。注释说明了理由 —— `find -type f` 会匹配硬链接，而指向根外文件的硬链接用这里可得的其他任何检查都区分不出来。
- **本地**：`O_NOFOLLOW` / `O_DIRECTORY` / handle inode 比对，且有一项负控证明缺这两个标志的平台**报出原因并 fail-closed，而不是退化成弱检查**。

竞争测试的可信度尤其要点名：**全文件没有一个 `setTimeout`**，替换都在确定性同步点里同步执行，而且每个测试都断言自己的同步点确实触发过。没有后一条，竞争测试完全可能因为从未真正竞争而静默通过。另有 `legitimate artifacts still read, list, and archive with no false refusals` 作为无误拒负控。

## 实施者事故与处置

### F 包 agent 中途终止

F 包 agent 在多次续跑无进展后终止，留下一个**被机械损坏的文件**：`plugins/dsh-agos/test/session-memory-zh-eval.test.mjs` 的 39 行被注入了行号显示前缀（形如 `    10|import …`），导致第 10 行 `SyntaxError`，整个套件 exit 1。

主控处置，逐步留证：

1. 确认损坏范围。只有该测试文件受损，三份 fixtures、README、`lib/session-memory.mjs` 全部干净（`grep -cE "^ *[0-9]+\|"` 均为 0）。
2. 确认是机械注入而非内容缺失。被注入的行号是完美等差序列 `10,20,…,390`（39 项），剥离前缀后每行剩余内容连同其自身缩进都是合法源码。
3. 剥离前缀，`node --check` 通过，残留命中 0。原始损坏副本留在 `/tmp/F-test-corrupted.bak`。
4. 修完后暴露出两项真实未完成状态，分别处置：

**`ret-08`**：召回失败集合与 `KNOWN_GAPS` 不符。核对后判定为 **fixture 过度指定，不是隐藏回归** —— 该样本两个要紧断言都通过（敏感条目连人工 pin 都被拒，store 里不存在，因此 `recall` 为空且 `notRecall` 命中），对不上的只有次要字段 `fallback`：fixture 写 `null`，实际报 `no-overlap`。登记而不改 fixture 的**决定**成立：该文件第 3 条纪律禁止改 fixtures 的 `expect`，而 `fallback: null` 表示「存在词面命中」，空 store 下任何诚实实现都给不出 `null`，所以是 fixture 把次要字段写窄了。

⚠️ **理由校正（2026-09-09，接线审查者 E2 实测证伪）**：此处原先写的理由是「`no-overlap` 恰恰是排序器唯一诚实的说法：**store 里还有别的条目**，query「密码」与它们没有整段重合」—— **事实错误**。`ret-08` 只有一个条目，而它在 pin 阶段就被 `SENSITIVE` 拒了，pin 之后 store 是**空的**，一条都没有。照原理由去修这条缺口的人会去找不存在的条目。

而正确的机制指向一条主控原先**漏记的真发现**：空 store 与「有条目但都不匹配」被报成同一个 `no-overlap`，且 `note` 声称「按重要度回注」时其实一条都没回注。主控实测（`lib/session-memory-rank.js`）：

```
空 store(ret-08 实况)     fallback="no-overlap" | items=0 | note="词面没有重合，按重要度回注"
有条目但都不匹配           fallback="no-overlap" | items=1 | note="词面没有重合，按重要度回注 1 条"
```

空 store 那一支断言了一次并未发生的回注（连数量后缀都没有），而「没有词面重合」这个说法本身预设了有东西可供比较。在一个把「缺席只能表示未采集」写进契约的包里，这两种情形共用一个标签正是该拆开的那种混同：空 store 是 not-collected，不是 no-overlap。**未改产品代码** —— 拆标签会动到 `fallback` 的对外口径、需要与前端一起改，本轮如实登记为下一轮 P2。

一处过程记录：主控曾试图把这条发现作为 `rank-empty-store` 写进 `KNOWN_GAPS.retrieval`，**立刻被 F 的纪律挡回来了，而且挡得对** —— F2-3 断言「失败 id 集合**等于**缺口清单」，而那张表按**夹具 id** 索引，塞一个非夹具 id 会从「多出一项」那侧报红。缺口表不是随记本，不该为了记事削弱它，因此改记在此处与 HANDOFF。

按该文件自立的纪律「绝不允许通过改 fixtures 的 expect 把条目删掉」，主控**没有动 fixture**，改为登记进 `KNOWN_GAPS` 并写明理由，保持可见。

**自检假阳性**：语料自检把评测器自身也扫进去（这是对的，评测器不该出现个人路径），但禁止模式表就写在同一个文件里，于是扫描器命中了自己的规则定义，报「命中禁止形状:会话归档目录」——命中的正是 `/\.dsh\/sessions|sessions-trash|agos-private/` 这行正则本身。

处置：用 `// self-scan:pattern-table:begin/end` 哨位注释显式划界，自扫时剜掉该区段。**没有选择把整个文件豁免** —— 豁免整个文件等于自检不再覆盖评测器本身。哨位缺失或次序颠倒时直接 assert 失败。

⚠️ **补强（2026-09-09，接线审查者 E1 实测证伪）**：这句原先还写「不允许静默降级成整文件豁免」，而当时的代码**做不到** —— 守卫只断言「哨位存在且有序」，不管被剜掉的区段有多大。把 `begin` 移到文件头、`end` 移到文件尾，断言照样通过，全文件被剜掉，自检彻底空转。审查者实测该路径剜掉 16727 字节、零命中、断言未触发。主控原先的两条反证（区段**之外**注入、**删掉**起始哨位）都绕开了这个方向，所以没发现。

现已补上区段的**大小上界**（1200 字节）与**内容**断言（必须框住 `const forbidden = [`），放宽哨位会撞上界而不是静默生效。主控复现审查者那条路径反证：报`自检哨位区段 16692 字节,超过上界 1200`。这句话现在名实相符。

两条负控证明自检没有变成空转（在 `/tmp` 的弃用副本上做，仓内未改）：

| 负控 | 结果 |
|---|---|
| 在哨位区段**之外**注入 `/Users/<name>/.dsh/sessions` | exit 1，报 `命中禁止形状:个人 home 路径` |
| 删掉起始哨位注释 | exit 1，报 `自检哨位注释缺失或次序颠倒,评测器自扫已失效` |

修复后 `plugins/dsh-agos` 全套件 exit 0、**165 个测试 163 通过 / 0 失败 / 2 跳过**（基线 154/0/2，净增 9 个测试，两项私有语料跳过原样保留、未被转成通过）。

### 对 F 已完成部分的主控复核

F 对生产库 `lib/session-memory.mjs` 加了三处**加法否决**，方向是收紧精确率，每条都写明了取舍：第三人称转述（`ATTRIBUTION_LEAD_RE`，且故意不收「要求/强调」，因为文本上分不开用户是在转达还是在提硬要求）、条件句不算事实（只拦 fact 分支，constraint 仍按原样收并保留「如果」字样让人看得见条件）、过时陈述不算现值（`isStaleDeclarative`，且要求过时标记落在判断词之前）。既有测试全绿。

评估读数保持诚实，缺口全部在 `KNOWN_GAPS` 里逐条写明「修了还是报了」：抽取 59 条中计分 53、通过 47、误收 1、漏收 5、两难 6（不计分）；来源 21/21；召回 9 条中计分 8、通过 6、误召回 1、fallback 口径不符 1、两难 1。

**未解决风险**：这三处收紧只在合成语料上验证过，对私有语料召回率的影响**没有度量**，因为该语料在本工作树不可得 —— 那正是两项跳过所覆盖的范围。不能因为合成语料全绿就推断线上召回不受影响。

F 剩余范围（同名同描述技能的来源冲突、turn-evidence 容量与保留边界审计、交接报告）已派新 agent 接手。

---

# 独立审查者的发现与处置

两名审查者的**首轮只读检查是在主控接线之前派出的**，因此其结论里有一部分在到达时已被后续工作覆盖。下面逐条标明「已过时 / 真发现已修 / 真发现未修」，过时的也保留记录并说明为什么过时——被独立推导出同一结论本身就是对修复的佐证。

按本轮规则「审查者必须复核主控完成后的生产接线」，另派了[接线审查者](cb3ca511-9a4b-4678-b02c-889f2a3840d3)专审主控改动，主控不自审自己的接线。

## 审查者 1（执行/持久化：C、D、E）

| # | 发现 | 处置 |
|---|---|---|
| P1-C1 | `withLedgerLock` 没有任何生产调用点 | **已过时**（见下） |
| P1-C2 | 新 ID 形状使前端试跑按钮失效 | **已过时**（见下） |
| P2-C3 | 未核验的 `taskRef` 被当成已核验落盘 | **真发现，未修 → 下一轮 P1** |
| P2-C4 | `taskRef` 由调用方可控且公开可读 | **真发现，未修 → 下一轮 P1** |
| P2-C5 | `appendLine` 可让整个事件循环停 30 秒 | **真发现，已修**（见下） |
| P2-C6 | `scanLedger` 数了坏行又把计数丢掉 | 真发现，未修 → P2 |
| P1-D1 | `linux-unshare` 兜底让整个宿主文件系统仍可读，却与 Seatbelt 同级标注 | **真发现，未修 → 下一轮 P1** |
| P2-D2 | 被削弱的断言以「有 Linux runner」为理由，而 runner 不存在 | **真发现**，两名审查者独立命中 |
| P2-E1 | `nlink !== 1` 误拒合法的同 run 内硬链接，且整个 run 一起失败 | 真发现，未修 → P2 |

### P1-C1 已过时，但它的独立推导佐证了修复

审查者 1 在接线前量到 `withLedgerLock` 只有定义、re-export 和 `appendLine` 内部三个引用，并且**实测**了后果：两个 racer，先落 `ok` 后落 `fail`，`CONFLICTING_RESULT` 不触发，`foldLedger` 末者胜，posterior 变成 `s:0,f:1`。它自己加了限定「`lib/index.js` 是你声明的第二轮接线面，所以这可能正在处理中」。

这与主控在 I6 里独立发现并修掉的是同一件事。有价值的是它给出了一条主控没量的补充事实：**完全相同的重复行不会被重复计数**（1、2、4 条相同 `ok` 都折叠成 `s:1,f:0`），所以损害范围限于「结果分歧的竞争」和台账噪音，不包括成功率虚高。这条限定收进了下一轮的风险描述。

### P1-C2 已过时：C 用双尾编码自行保住了前端契约

审查者 1 量到前端 362/3，并实测 `postAssembleDispatch` 返回 `{"ok":false,"error":"提案编号未采集，无法指定试跑对象"}`。那是 C 定稿前的快照。本轮复核：`mintAssembleId()` 现在铸出 `asm-17888841926525678739`（20 位纯数字），前端 `/^asm-\d{1,20}$/` 原样收，前端 365/0/1。

两名审查者独立给出了同一份「把前端正则改成镜像 router `ID_RE`」的补丁并各自验过负例。主控**未采纳**，理由：当前没有任何生产者铸出 hex 尾的 `asm-`/`dsp-`，放宽正则会产生一条无覆盖的分支；而 `dec-` 已拿到完整 128 位。真正值得修的不是正则宽度，而是**这个两侧契约没有任何交叉检查**——下一轮该加的是「用 router 的 `ids.js` 真铸一个 ID、断言前端正则收得下」的测试，让将来任何一次形状变更在前端套件里大声失败，而不是静默让按钮失灵。已记入 HANDOFF。

### P2-C5 真发现，已修：而且这道风险是主控接线放大的

`acquireLedgerLock` 等锁走 `Atomics.wait`，它 park 的是**整个单线程 host**，不是当前这一个请求，默认超时 30 秒。接线前 `appendLine` 只在追加那一瞬取锁；接线后临界区变成「读 → 判定 → 追加」整段——事务性的代价，不能退回去，但撞锁概率随之上升。所以这条虽由审查者指出机制，责任在主控的接线。

实测临界区成本（`readLedgerLines` + `foldLedger`）：百行 0.2ms、千行 0.6ms、万行 5.3ms。据此在 `lib/index.js` 的四个接线点传 `timeoutMs: 5_000`：约为临界区的一千倍余量，又必须大于 `recoverStale` 内部那把恢复锁的 2 秒，否则一次正当的陈锁回收会吃掉整个预算。

改前先排除了一个陷阱：`isStale` 用 owner 记录里的 `timeoutMs` 作过期窗口，缩短它会不会让别人抢走自己正持有的锁？读代码确认不会——对「活着且 start time 匹配」的 owner 一律返回 `false`，窗口只决定何时启用昂贵的 PID 复用检查。超时本身是 fail-closed 的（抛 `AGOS_LEDGER_LOCK_TIMEOUT`，不写盘）。

新增 `test/index-lock-timeout.test.mjs` 两条，**两侧都钉**：上界（长期占锁时必须在 5 秒预算内放弃，实测 5106ms）与下界（500ms 的正当争用必须等住并成功，实测 586ms）。两条互为负控：只钉上界，有人把 `timeoutMs` 设成 1 也能过；只钉下界，退回 30 秒默认值也能过。反证：抽掉四处 `HTTP_LOCK` 后耗时 30017ms，上界条红并精确报出「退回了 30000ms 默认值」，下界条仍绿（符合预期，它不受该改动影响）。

### P1-D1 未修，理由与去向

`linux-unshare` 的 prelude 把 `/` remount 成**只读**，不是**不可读**——沙箱内仍能读 `$HOME`、`/etc`、凭据文件；而 macOS profile 是 `(deny default)` 加显式读白名单。更要紧的是审查者 1 指出的两点：`SMOKE_SCRIPT` 恰好只检查了 unshare 能满足的两条性质（scratch 可写、`/usr` 不可写），而 manifest 的 `verificationBoundary` 是单个字符串、测试把三个后端当同级接受，操作者读 manifest 无法分辨哪一个没有约束读取范围。

未修的理由：本轮 Linux **完全没有动态验收**（本机 docker/podman/colima/lima/nerdctl 五项全缺，D 如实维持 `verification-unavailable`），改一个跑都没跑过的后端只会把未验证的代码换成另一份未验证的代码。审查者 1 也明确写了它的 P1-D1「是从 argv 与 mount 语义读出来的，不是观察到的泄漏」。下一轮的正确顺序是先有 Linux 环境，再按「把读取范围也写进 smoke 与 `verificationCapabilities`，或干脆只留 bubblewrap」二选一落地。

### P2-D2：两名审查者独立命中同一处，且「runner 不存在」已证实

`autoresearch-workspace.test.mjs` 把非 darwin 上的硬断言 `assert.equal(sandbox.ok, false)` 改成了接受 Linux 后端的分支，理由写的是「其运行时由 Linux runner 覆盖，不在此处」。主控核实：**本仓没有任何 CI 配置**——`.github/workflows` 不存在，仓内除五个插件的 `cordis.patch.yml` 外没有 yml/yaml。所以该理由指向的 runner 不存在，在 Linux 主机上那条测试会只断言一个 `kind` 字符串就返回，跳过全部五项行为检查且不被标记为 skip。记入 HANDOFF：要么落地 runner，要么撤回该理由并还原硬断言。

## 审查者 2（前端/协议：A、B、F + 主控依赖工作）

| # | 发现 | 处置 |
|---|---|---|
| P1 | 锁文件声称 registry 来源，磁盘却是别的内容，且无任何检测 | **真发现，已加检测器；并带出主控文档三处错** |
| P2-A | `dependency-surface.json` 只测到每个套件的第一个缺包 | 真发现，未修 → P2 |
| P2-A | 计数下限门形同虚设（`expected-counts.json` 从未生成） | **真发现，已生成基准** |
| P2-A | 负控套件不在任何门的退出码里 | 真发现，未修 → P2 |
| P2-A | `layers.json` 3.18.1 与 `plugins/package.json` 3.18.2 两个真源不一致 | **真发现，已解释：对的一侧是 3.18.1** |
| P2-B | `page.unroute(<新建箭头函数>)` 是可证的空操作 | 真发现，泄漏已被 B 的「每场景新页」兜住，三处调用是死代码 → P3 |
| P3-B | `host-env.mjs` 默认值写死个人绝对路径 | 真发现，未修 → P2 |
| P3-B | 联测产物会被提交，且内嵌个人路径 | **真发现，已修** |
| P3-B | token 脱敏有跨 chunk 边界漏洞 | 真发现，未修 → P3 |
| P3-F | `mustNotAppear` 断言是重言式；被拒 pin 免除了应召回项；`ret-08` 理由与夹具不符；`preference` 类无同类硬负例 | 真发现，未修 → P3 |
| 跨包 | `dispatch.test.mjs` 从个人 live profile 绝对路径 import | **真发现，已修**（A 包独立命中同一处） |

### P1：发现成立，而且**推翻了主控自己文档里的三处结论**

审查者 2 的原话是：清单声称的可复现性并不存在，而且没有任何东西会发现——在 `plugins/` 里跑一次 `npm ci` 就会把工作树换成 registry 内容并让套件变红，而锁文件的 integrity 哈希让这棵树看起来像是被验证过的。成立。

复核时查出主控 `DEPENDENCIES.md` 有三处写错，已就地校正并留校正记录（详见该文档）：

1. **`@deepseek-ai/dsh-settings` 根本不是「本机产物」，是主控钉错了版本。** registry 上存在 `0.1.0-rc.6`，其 `lib/index.js` 与磁盘副本**字节等同**（`18e5dd39…`）且含 `installSettingsSection`。原文把它列进「公网不可得」是错的。但它也不能简单改声明：该版本声明 peer `dsh-invariants@^0.1.0-rc.6`，与树里另外七个包要求的 `^0.1.2-rc.1` 冲突，`npm install` 实测 ERESOLVE（已回滚，本轮禁止 `--force`）。
2. **原记录的两个树摘要按任何已声明口径都复现不出来**，已作废。一个复现不出的摘要比没有摘要更糟——它看起来可验证。
3. **原「风险 3」关于 schemastery 的理由是错的**：真正在树里的 `dsh-settings@0.1.0-rc.6` 声明 peer `^3.18.1`，所以插件声明的 3.18.1 与实际树一致，A 包 `layers.json` 写 3.18.1 也是对的。审查者 2 报的「两个真源不一致」由此解释：不一致存在，但对的那一侧是 3.18.1。

另外查实：审查者 2 因被要求不得跑 `npm install` 而无法验证的那一半，主控补上了。`dsh-kimicode-swarm` 的 registry 0.1.0/0.1.1/0.1.2 三个版本**都不导出** `dsh-fleet` 需要的 `publishProgress`/`parseResultsXml`/`escapeXml`/`textOf`，磁盘那份（本机构建的 `kimicode-swarm-aligned`）是唯一来源。所以**不可公网复现的包从两个降到一个**，但那一个是真的。

**修复**：新增 `scripts/acceptance/verify-host-tree.mjs`，不假装树能由 `npm ci` 产生，只负责在内容偏离「产出绿色结果的那份」时大声失败并指名道姓。摘要口径写在脚本顶部、覆盖包内所有文件（换掉一个 `.node` 二进制同样要被发现），缺基准时 fail-closed。反证实测：把 registry 的 `dsh-kimicode-swarm@0.1.0` 换进去，**版本号与文件数都不变**（同为 `0.1.0`、34 文件），仅摘要不同，脚本正确报红并指出最可能病因与恢复来源——这正是任何版本检查都抓不到的一类。`plugins/package.json` 的 `description` 也已写明清单本身的局限。

顺带说明为什么不能用 `npm ls` 当门：它在本目录**必然**报 `ELSPROBLEMS ... invalid`（上述钉错版本的既有后果），属预期稳态，永远是红的。

### 由此浮出的更重要结论：`dsh-fleet` 与 pin 的宿主线不兼容

`escapeXml` → swarm → `installSettingsSection` 这条链只存在于 rc.6 及更早，而 `0.1.0-rc.6` 的 peer 属 rc.6 线、与 pin 的 0.1.2-rc.1 线冲突。也就是说 **`dsh-fleet` 按现在的写法无法在 `frontend/UPSTREAM.pin` 声明的宿主线上安装成立**；desktop profile 能跑正是因为它整体停在 rc.6，与契约研究者独立得出的「desktop profile 停在 rc.6 线」一致。这比「某个导出缺失」严重一级：不是补一个导出能解决的，是版本线选择问题。本轮记录为发现项，未修。

### 跨包已修：`dispatch.test.mjs` 的绝对路径 import，以及它镜错了版本线

A 包的依赖面测量与审查者 2 独立报到同一处：`test/dispatch.test.mjs` 从 `/Users/<name>/.dsh/profiles/desktop/node_modules/...` 静态 import。这是模块级 import，换任何一台机器**整个测试文件都加载不了**。

修的时候查出第二个、更要紧的问题：desktop profile 那份 `assembler.js` 是软链进 DSH Desktop.app 的 rc.6 副本，与本树 pin 的 0.1.2-rc.1 **内容不同**（`cfe654a0…` vs `3257b31b…`）。也就是说这条「用宿主真 `BlockAssembler`」的契约镜像，镜的是 pin 之外的另一条版本线。改成仓库相对路径后对着 pin 复跑，13/13 仍通过，所以断言在两条线上都成立，但现在它至少断言的是 pin 真正声明的那一条。

裸包名不可用是有原因的（`exports` 映射没导出该子路径，裸 import 会 `ERR_PACKAGE_PATH_NOT_EXPORTED`），已在文件里写明，避免有人把它「整理」成裸包名而直接加载失败。

### 已修：联测产物的可发布性

实测 B 的一次运行产物里有 **43 处个人绝对路径**，分布在 `host.log`(30)、`results.json`(9)、`probe-host.log`(2)、`run.log`(1)、`probe-host-findings.json`(1)，且**完全没有被忽略**。宿主与 playwright 都会把绝对路径打进日志，这不是靠「记得脱敏」能解决的，所以从入库层挡掉：新增 `frontend/tests/host-integration/.gitignore` 忽略 `artifacts/`，并在其中写明交付证据应走 `docs/engineering/<轮次>/logs/` 的脱敏声明流程。

### 已修：验收入口不再读操作者的私有 Fleet 历史

A 包的依赖面测量报了「两个套件依赖 `~/.dsh` 绝对路径，装包解决不了」，并称 `http-routes.test.mjs` **写入**用户真实的 `~/.dsh/logs/fleet/runs.jsonl`。复核后修正这条描述：**是读，不是写**。而且 C 恰好预见过写的风险——`outcomes.js:26` 明确写了不能用 `new FleetLedger`，因为构造即触发 `autoCompact` 重写文件，「纯读会变成写」，所以那里用的是裸 `readFile` 逐行 parse。

但只读同样是缺陷：套件结果取决于这台机器上跑过哪些 Fleet 批次。代码里本来就留了覆盖点（`DSH_FLEET_RUNS_FILE` / `DSH_FLEET_LEDGER_PATH`），只是没人用。已在 `scripts/acceptance/lib/exec.mjs` 的 `neutralEnv()` 里把它指向不存在的临时路径（与私有语料同法——**指向不存在的路径而不是删变量**，删掉会让代码落回 `homedir()` 兜底，等于没关），并让验收入口自报这一行。

实测：置为不存在路径后 `dsh-agos-router` 122/122、`dsh-fleet` 148/148 仍全绿，说明套件本来就不依赖私有历史；这次改动是把「事实上自足」变成「结构上自足」。

### 已修：计数下限门从「写好但没装弹」变成真的能抓

审查者 2 指出 `expected-counts.json` 从未生成，于是 `FLOORS = {}`、每个闸的 `minTests/minPass` 都是 `null`，而 A 自己的负控（NC6b）恰好记录了为什么这要紧：**Node 会把清空的测试文件算成 1 个通过**，所以 `pass > 0` 抓不到删套件，只有下限能抓。A 当时故意推迟是因为测试总数在涨（453→916），冻早了只会造假警报——这个理由成立，但树现在已稳定。

已用 `--write-floors=scripts/acceptance/expected-counts.json` 从一次全绿运行生成（该开关在红树上会拒绝执行）。对真实门反证：把 `dsh-mcp-bridge/test/mcp.test.mjs` 清空后跑验收，生产者 **exit 0**、报 **pass 1 / fail 0**（正是 NC6b 描述的形状），门却正确报红 `test-count-regression: tests 1 < floor 4`，进程退出码 1。没有下限，这就是一次会溜过去的假绿。文件已还原、复跑 4/4。
