# 本轮交接 — 完成项、剩余项、下一步

主控单写。**本文件在两名独立审查者与独立验证者结论到齐前不构成验收完成声明**；最终结论一节见文末状态标记。

工作区 `/Users/<name>/Projects/agos-round2-20260908`，分支 `cursor/agos-round2-20260908`，基线提交 `7e7e359801644b77b302835f374f035e2836926d`。本轮**未** push、未合并 main、未部署、未重启 DSH、未操作任何真实 Fleet 机器。

## 完成项

以下每一项都由主控独立实跑核验过，不是采信 agent 自述。命令、退出码与真实结果见 [VERIFICATION.md](VERIFICATION.md)，逐包核验依据见 [REVIEW.md](REVIEW.md)。

| 包 | 完成的行为 | 性质 |
|---|---|---|
| **主控** | 摆脱 `scripts/dev-links.sh` 指向 `~/.dsh/profiles` 的软链，建立可复现隔离宿主依赖树（两层 `node_modules`，版本全部钉死到 pin 的 0.1.2-rc.1，不用 `--force` / `--legacy-peer-deps`），并查清上一轮验收不可在干净机器复现的根因 | 真实安装，`npm ci` 可复现 |
| **A** | 验收入口：代码门与部署漂移分通道、保留生产者真实退出码、默认不读个人语料不访问供应商；**并给验收夹具本身写了 14 项自测（13 项负控）** | 真实执行 |
| **C** | JSONL 跨进程写入与读改写一致性；普通决策与试跑 ID 改为抗碰撞身份并保留历史兼容；原始任务身份绑定到 decision/dispatch/verdict/outcome，拒绝跨任务套用与重放 | **真多进程 + 真 SIGKILL** |
| **D** | Linux OS 隔离执行器，能力检测显式、每次拒绝点名缺失能力；macOS Seatbelt 既有行为保留 | Seatbelt 侧**真子进程**；Linux 侧**未动态验收** |
| **E** | 远端产物读取的目录替换、软链/硬链接、检查后替换竞争；校验与访问绑定同一对象（远端靠 cwd inode + `pwd -P` 逐层等式，本地靠 `O_NOFOLLOW` + handle inode），能力不足明确拒绝 | fake SSH + 真实临时目录 + 确定性同步点 |
| **F** | 可公开的中文合成 fixtures（九类齐全，含难负例）；抽取/来源/召回三份报告分开；缺口全部在 `KNOWN_GAPS` 里写明「修了还是报了」，不靠改标签掩盖 | 合成语料 |
| **B** | 真实 pin 宿主 + 真实浏览器 + 真实 transport + 真实 live store 的端到端联测，隔离 `DSH_HOME` 与 fake provider | **真宿主 + 真浏览器** |

## 剩余项（明确未完成，不得记为通过）

### 1. Linux 沙箱未动态验收 —— 环境所限

本机 `docker` / `podman` / `colima` / `lima` / `nerdctl` **五项全缺**，本轮**未**擅装任何容器运行时或系统级服务（执行边界禁止）。因此 D 的 Linux 执行器只验证了能力检测与 fail-closed 决策逻辑，**没有一条 Linux 上的真实隔离证据**，状态维持 `verification-unavailable`。

补齐所需的最小环境与实验：

1. 一个可用的 Linux 环境（本机容器运行时，或一台可 SSH 的 Linux 机器；不要用生产节点）。
2. 在其上跑 D 的能力探测，确认 `bwrap` 或 `unshare` 加必需 flag 齐全、非特权 user namespace 未被 sysctl 或 AppArmor 关闭。
3. 然后跑七项真实子进程场景（根外 sentinel 不可读写、评分文件不可改、合成 secret 不继承、loopback 被拒、scratch 可写、超时无遗留子进程、产物导出后临时仓清理）—— 这七项目前**只在 macOS Seatbelt 上**有真实证据。

### 2. pin 宿主 web profile 上会话删除被永久 503 挡住 —— P1，本轮如实上报未修

`host.describe` 在 pin 宿主上已完全移除，导致 `attachedFromRpc` 恒返回 `available:false`，`assertDetached` 因此恒抛 `503 LIVE_STATUS_UNAVAILABLE`。**不是安全缺陷**（方向是拒绝删除，不是误删），但**是功能阻塞**，且错误文案把永久失效说成「暂时无法确认」。完整链条与取证过程见 [REVIEW.md](REVIEW.md) 的 I4。

本轮不改的理由是不能猜：`session/list` 的实现在 CLI 包里、不在隔离依赖树内，它列出的到底是「已挂载」还是「宿主视野内（含冷会话）」两种读法会导出相反的删除结论，而本轮明确规定不根据字段名猜测。

下一步的实验，做完再动代码：

1. 在真实 pin 宿主上，对**一个已知挂载**与**一个已知分离**的会话分别查 `session/list`，比对差异，确定「挂载」的权威判据。
2. 依此重写 `attachedFromRpc`（属主控所有权）。
3. **先补测试**：这条兜底是全仓唯一没有测试的路径 —— 所有测试都注入 `readAttached: { available: true, … }`，真实 RPC 兜底只在生产上跑过。决定「允不允许删除」的代码恰好没被测过。
4. 在判据确定之前，至少把 503 文案从「暂时无法确认」改成能反映永久失效的说法。

### 3. `asm-` / `dsp-` 的随机尾只有约 23 位 —— 取舍未决

C 为保住前端已发布契约，让这两种 ID 停在 13 位时间戳 + 7 位随机（约 23 位），而插件内部的 `dec-` 用满 128 位。C 在 `C-wiring.md` 里给了放宽前端正则的 apply-ready diff，可让它们也用满 128 位。前端归主控。判据是「23 位在实际并发下够不够」，不是「能不能改」。

### 4. turn-evidence 的断尾行会连带吃掉下一行 —— 已审计、已钉测试、**未修**，等主控定夺

F2 审计 `lib/turn-evidence.js` 后**没有加任何清理**，这个结论是对的（三条理由见 `wiring/F-wiring.md` §6，尤其第二条：凭空发明 TTL 会把操作者屏幕上还在的一跳从「本跳已记录」变成「本跳未采集」，而这个模块的契约恰恰规定「缺席只能表示未采集，不能表示采集过又被悄悄丢掉」）。

其中一项边界需要主控决定，本轮**未修**：写入方从不检查文件是否以换行结尾，因此崩溃打断追加后，**下一行会接在残片后面，两行一起解析失败**，而 `record()` 对后一行照样返回了 `persisted: true`。损失恰好一行，再往后自动恢复。当前行为已被 `test/turn-evidence-capacity.test.mjs` 钉住，不会静默变化。

两种修法，取舍不是「哪个便宜」：

| 修法 | 成本 | 风险 |
|---|---|---|
| **写侧**（F2 给出的形状）：追加前若文件不以 `\n` 结尾就补一个 | 在**每个** pre-step 路径上多一次读 | 无。只是补分隔符 |
| **读侧**：解析失败时从残片里找回后半行 | 热路径零成本，只在极少的坏行上跑 | **会编造证据**。残片里若恰好含 `{"sessionId":"…"}` 形状的文本，「恢复」出来的可能是看似合法但错误的一行 —— 而这个模块开头就写着 `Never invents zeros` / `Persist ≠ observe` |

读侧看着更便宜，但它引入的正是本模块禁止的失败模式。**因此 F2 选的写侧形状是更稳的那个**，下一轮若要修应当走写侧。本轮不动的理由是时序：独立审查已经开跑，在这个时点改一条写路径而不让审查者重看，代价高于留一个有测试钉住、有文档记明的已知边界。

### 5. 未做的验收

- **真实宿主端到端：九个场景全部在真宿主上通过**（`host=real browser=real transport=real store=real`，`hostExit.code=0`，模型为 `agos-fake`）。但有两处范围要看清，B 自己也写明了：
  - **场景 8 的证明范围比标题窄。** stock 宿主没挂 `/api/turn-evidence/*`，证据条渲染成 `本跳证据未采集:HTTP 404`。它坐实的是「分页进历史轮次不会改写当前跳的 turn/step 定位」（前后都是 turn=30 step=1，且始终等于窗口最大轮次，窗口从 50 扩到 62），**没有**坐实「有内容的历史证据不会串进最新一跳」—— 那需要一个真的会产证据的宿主插件。turn-evidence 插件挂上后应当补一轮。
  - **「浏览器直连宿主」没有验证。** 浏览器经 Vite 代理改写头并注入签名 cookie，协议帧是宿主原件，但真实部署若不经同源代理，信任栅栏行为需要单独验。
  - **模型与工具是假的**，这是刻意取舍。审批、传输、分页这些被测语义与模型无关，所以取舍成立；但任何「模型行为已验证」的说法都不成立。
- **部署漂移**：`scripts/deploy-plugins.sh --check` 退出 1，工作树代码与 `~/.dsh/profiles/{desktop,web}` 的已部署副本存在漂移（`dsh-agos` 21 项、`dsh-agos-router` 17 项、`cn-capabilities` 15 项、`dsh-mcp-bridge` 2 项等）。**这是预期的**：本轮不部署。它被放在 advisory 通道，真实退出码保留但不参与进程退出码。
- **生产构建与 `vendor:diff`**：归主控，在接线完成后执行。

### 6. 内容漂移：`dsh-kimicode-swarm` 不可从公网 registry 复现

该包在操作者桌面 profile 里的实装内容与公网同版本号不一致（本轮以 `cp -RL` 解引用成实体副本纳入），因此**隔离依赖树目前仍有一个包不是纯 registry 可复现的**。证据与逐层单变量确认过程见 [DEPENDENCIES.md](DEPENDENCIES.md)。这一项需要上游确认正确的发布产物，不是本地能修的。

## 给下一轮的注意事项

1. **不要复用任何旧测试数字。** 上一轮的 833/0/3 只在「pin + 两个操作者提供的包」这一种依赖配置下成立；同一份代码在纯 registry 配置下 `dsh-fleet` 与 `cn-capabilities` 都是红的。三种配置的实测对照见 [VERIFICATION.md](VERIFICATION.md)。
2. **`plugins/*/lib/index.js`、`frontend/package.json`、锁文件、`tsconfig`、共享 CI 配置只能有一个 writer。** 本轮由主控单写，实施者提交 apply-ready 接线建议（`docs/engineering/agos-round2-20260908/wiring/*.md`），主控串行整合。
3. **`plugins/dsh-agos` 的两项跳过需要私有语料，是跳过不是通过。** 任何把它们变绿的改动都要先解释语料从哪来。
4. **F 新增的三处否决门（第三人称转述、条件句、过时陈述）只在合成语料上验证过**，对私有语料召回率的影响没有度量 —— 那正是这两项跳过覆盖的范围。不要因为合成语料全绿就推断线上召回不受影响。
5. **区分夹具失败与产品失败。** B 的场景 8 是夹具超时，不是产品缺陷；主控已要求把前置条件不满足报成 `blocked` 而不是 `fail`，否则一个混合信号无法签验收。

## 状态

- [x] 六个实施包已派发并回收（F 中途终止，主控修复后由 F2 接手剩余范围）
- [x] 主控完成可复现隔离依赖树与依赖根因调查
- [x] 契约研究者完成，主控修正其中一处结论
- [x] 主控逐包独立核验 A、C、D、E、F
- [x] B 场景 8 夹具修复与重跑 —— 已完成，`artifacts/results.json`（2026-09-08T16:00:21Z）为 9/0、`hostExit.code 0`。
      但它的证明范围比标题窄：证据条在那次运行里自报「未采集：HTTP 404」，「历史证据不串到最新一跳」这条没有被真正施压（详见 REVIEW.md 的 I5）。
- [ ] F2 剩余范围（同名同描述技能来源、turn-evidence 保留边界、交接报告）
- [ ] 主控串行整合共享入口 `lib/index.js` 与 CI
- [ ] 两名独立审查者复核**主控完成后的生产接线**
- [ ] 独立验证者跑最终修改范围的全套件与失败负例
- [ ] 最终验收结论

**在最后三项打勾之前，本轮不得宣布验收完成。**

---

# 独立审查后的最终状态（2026-09-09）

## 审查阶段主控又改了什么

两名审查者的首轮只读检查在主控接线前派出，其发现里有真有旧。下面是**接线之后**、由审查触发的改动，全部已实跑并反证：

| 改动 | 文件 | 反证 |
|---|---|---|
| HTTP 处理器持锁超时 30s → 5s | `dsh-agos-router/lib/index.js`（4 处） | 抽掉后耗时 30017ms，上界测试红 |
| 锁超时两侧钉死（上界+下界互为负控） | `dsh-agos-router/test/index-lock-timeout.test.mjs`（新建 2 项） | 见上 |
| 宿主树内容校验器 | `scripts/acceptance/verify-host-tree.mjs`（新建）+ `host-tree-digests.json` | 换入 registry 内容后正确报红（同版本号、同文件数、仅摘要不同） |
| 计数下限基线（原本 `FLOORS={}`，门形同虚设） | `scripts/acceptance/expected-counts.json`（新建） | 清空一个测试文件：生产者 exit 0/pass 1，门报红 `tests 1 < floor 4` |
| 验收不再读操作者私有 Fleet 历史 | `scripts/acceptance/lib/exec.mjs` | 置不存在路径后两套件仍 122/122、148/148 |
| 测试不再从个人 live profile 绝对路径 import | `dsh-agos-router/test/dispatch.test.mjs` | 改仓库相对路径后 13/13 仍通过 |
| 联测产物不再入库（43 处个人路径） | `frontend/tests/host-integration/.gitignore`（新建） | `git check-ignore` 确认生效 |
| 清单写明自身局限 | `plugins/package.json` description | — |
| 依赖文档三处结论校正 | `DEPENDENCIES.md` | 见该文档校正记录 |

**最终全门**：`node scripts/acceptance/run-acceptance.mjs --with-frontend` → **exit 0，pass 924 / fail 0 / skip 3**，部署漂移 exit 1 留在 advisory 通道不参与退出码。

## 下一轮 P1（按建议顺序）

1. **未核验的 `taskRef` 被当成已核验落盘**（审查者 1 P2-C3，实测确认）。`checkTaskBinding` 在无人声明时返回 `{ok:true, taskRef:expected, unverified:true}`，而 `bindOrdinaryOutcome` 无条件把 `taskRef` 写进记录，`taskUnverified` 只存在于内存返回值。后果：「没声明任务」与「声明并核验通过」两种行的**磁盘字节完全相同**，任何事后审计比较 `outcome.taskRef === decision.taskRef` 都按构造成立。修法：只在 `unverified === false` 时落 `taskRef`，或显式持久化 `taskBinding: 'verified' | 'unverified'`。负例（`TASK_MISMATCH`）本身是对的，保留。
2. **`taskRef` 由调用方可控且公开可读**（审查者 1 P2-C4）。手工路径直接用 `body.taskRef` 作 claimed，而 `publicizeDecision` 剥了 `task` 却没剥 `taskRef`；于是从 `GET /api/agos/routes` 读到指纹再回显，就能把 `unverified` 从 true 翻成 false。`detectForgedSource` 确实挡住了伪造自动裁决，所以这不能伪造 reviewer 结论，但足以让手工录入的结果自称「任务已核验」。附带：该哈希是**截断前**全文的 sha256，公开它等于给猜测任务串提供确认预言机，与当初特意 `delete out.task` 的意图相反。
3. **`linux-unshare` 的读取范围与 Seatbelt 不同级，却共用一个 `verificationBoundary` 字段**（审查者 1 P1-D1）。prelude 把 `/` remount 成只读而非不可读，沙箱内仍能读 `$HOME`、`/etc`、凭据文件；而 `SMOKE_SCRIPT` 恰好只检查 unshare 能满足的两条。**先有 Linux 环境再动**——本轮该后端一次都没跑过，改它只是把未验证代码换成另一份未验证代码。二选一：把读取范围写进 smoke 与 `verificationCapabilities`，或只留 bubblewrap。
4. **`dsh-fleet` 与 pin 的宿主线不兼容**（主控本轮新发现，见 `DEPENDENCIES.md`）。`escapeXml` → swarm → `installSettingsSection` 这条链只存在于 rc.6 及更早，而 `dsh-settings@0.1.0-rc.6` 的 peer 属 rc.6 线、与 pin 的 0.1.2-rc.1 冲突（`npm install` 实测 ERESOLVE）。不是补一个导出能解决的，是版本线选择问题：要么改 `dsh-fleet` 不再依赖那条链，要么把 pin 移到 rc.6（后者须先审计）。
5. **web profile 上会话删除被永久 503 挡住**（上一节 I4，本轮未改）。`host.describe` 已从 pin 宿主完全移除，契约研究者独立确认（对整棵已装宿主 `rg` 命中 0），并额外指出操作者自己的 `@dsh-local/agos` 插件仍在调 `/api/host.describe`。

## 下一轮 P2（独立验证追加，2026-09-09）

- **14 个历史遗留文件含操作者绝对路径**（`/Users/<name>`）。本轮已把**自己引入的** 28 处清零
  （产物目录忽略、`dependency-surface.json` 写盘层脱敏、`host-env.mjs` 改 `homedir()` 推导、文档占位），
  实测本轮引入项为 **0**；但基线里就有的 14 个未动：上一轮文档 6 个、前端测试 5 个、
  `plugins/dsh-agos/test/{plugins-inventory,session-trash}.test.mjs`、`plugins/dsh-fleet/lib/index.js`。
  未动的原因是它们不在本轮所有权范围内，且前端测试那几处改动需重跑前端闸。

- **`host-env.mjs` 的 `PLAYWRIGHT_MODULE` 默认值仍指向 live `web` profile 内部。**
  本轮只解决了「写死个人路径」（已改 `homedir()` 推导），**没有**解决「默认去操作者 live profile
  里借 playwright」这件事本身 —— 它与该文件自己「从不读写 `~/.dsh`」的声明仍然矛盾。
  正确做法是把 playwright 装进 `frontend/` 的隔离依赖树，或要求显式提供路径而不给默认值。

- **`--floors=none` 是新增的逃生阀，需要防它变成习惯用法。** 本轮把计数下限门改成 fail-closed
  （缺基线退 78）后，`--floors=none` 是唯一的绕过方式且会醒目自报。下一轮若要更严，
  可以让 CI 层直接拒绝带该参数的调用。

## 下一轮 P2（接线审查追加，2026-09-09）

以下四条来自第三名独立审查者对**主控自己的接线与修复**的复核（报告见 [REVIEW-CONTROLLER.md](REVIEW-CONTROLLER.md)）。
其中被判为阻塞的 C1、两条 P2 与多数 P3 已在本轮修完（见 [REVIEW.md](REVIEW.md) 与 [VERIFICATION.md](VERIFICATION.md) 的反证表），
这里只留**本轮未修**的。

- **空 store 与「有条目但都不匹配」共用 `no-overlap`，且 `note` 声称了并未发生的回注**（审查者 E2 的理由校正带出，主控实测确认）。
  `lib/session-memory-rank.js`：空 store → `items=0` 但 `note="词面没有重合，按重要度回注"`（连数量后缀都没有）；
  有条目但不匹配 → `items=1`、`note="…回注 1 条"`。在一个把「缺席只能表示未采集」写进契约的包里，
  空 store 是 **not-collected**，不是 no-overlap。未修的原因：拆标签会动 `fallback` 的对外口径，需要与前端一起改。
  注意 `KNOWN_GAPS` **不是**登记它的地方 —— 那张表按夹具 id 索引，塞非夹具 id 会被 F2-3 正确地判红。

- **真宿主联测的 harness 没有 `blocked` 状态**（审查者 F1 追问，主控查证）。`run.mjs` 的状态词汇只有 `pass`/`fail`，
  全仓无 `blocked`。后果具体：场景 8 那次运行里证据条自报「未采集：HTTP 404」，
  「历史证据不串到最新一跳」这条子断言因此没有被真正施压，但在 `results.json` 里它与一次真正的通过**不可区分**，
  只有读 `run.log` 的断言文本才看得出来。这正是 I5 当初要求「`blocked` 与 `fail` 分开报」的原因，该要求尚未落实。

- **`transact` 注入点删掉后仍无直接覆盖**。本轮补了 `withLedgerLock` 的 thenable 闸（传 async 回调直接抛错，已反证），
  约束了「注入点将来被误用」的方向；但「把 `transact` 那一行删掉」本身仍不会让任何测试变红。

- **`dependency-surface.json` 每轮只报第一个缺失包**（审查者 2 P2，仍未修）。`prepare-host-modules.mjs --check`
  因此可能在还缺多个宿主包时就报「依赖面就绪」。修法是迭代测量到不动点。

## 下一轮 P2

- **前端↔router 的 ID 契约没有任何交叉检查**。本轮两名审查者都独立推导出「放宽前端正则」的补丁，主控未采纳（当前无生产者铸 hex 尾的 `asm-`/`dsp-`，放宽会产生无覆盖分支）。真正该加的是「用 router 的 `ids.js` 真铸一个 ID、断言前端正则收得下」的测试，让形状变更在前端套件里大声失败而不是静默让按钮失灵。
- **`dsh-agos-router` 的第四个接线点（`transact` 注入）仍无覆盖**。隔离反证确认单删那行仍 122/122。
- **`dependency-surface.json` 只测到每个套件的第一个缺包**（审查者 2）。Node 只报模块图里第一个未解析的 specifier，于是 `dsh-fleet` 只记了 `schemastery`，而它在模块层还需要另外三个；`prepare-host-modules.mjs --check` 因此会在 8 个套件都加载不了的机器上报「依赖面就绪」exit 0。修法：迭代测量到不动点。另：`dispatch.test.mjs` 那条警告现已过时（本轮已修），重测即消。
- **A 的负控套件（14/14）不在任何门的退出码里**，`defaultPlan()` 里没有它，`test-all.sh` 也不引用 `scripts/acceptance`。它是普通 `node --test` 生产者，可直接作为 `codeGate` 接入。
- **`scanLedger` 数了坏行又把计数丢掉**（审查者 1 P2-C6）：`readLedgerLines` 丢掉 `rejected`，`listRoutes` 的 stats 不报，于是有坏行的台账渲染成完整台账。
- **`nlink !== 1` 误拒合法的同 run 内硬链接，且整个 run 一起失败**（审查者 1 P2-E1，已用夹具实证）。拒单个文件是对的且不可避免，但不该让 manifest/file/tgz 三条路由整个 run 返回 409；改成逐条拒绝并在响应里列出 `refused`。
- **`host-env.mjs` 默认值写死个人绝对路径**（审查者 2 P3-B）：`DSH_BIN` 与 `PLAYWRIGHT_MODULE` 的默认值指向 `/Users/<name>/...`，其中后者读的是操作者 live `web` profile 内部——与该文件自己「从不读写 `~/.dsh`」的声明相矛盾。有 env 覆盖所以能跑，但默认值使这套联测只在这台机器成立，正是 A 包存在的目的所要消除的那一类。未修的原因是改它须重跑 B 的 9 场景真宿主联测。

## 下一轮 P3

- `page.unroute(<新建箭头函数>)` 是可证的空操作（函数匹配器按引用相等比较），三处调用是死代码；跨场景泄漏已被 B 后来的「每场景新页」兜住，所以只是清理。
- B 的 token 脱敏有跨 chunk 边界漏洞（`start-host.mjs`）：匹配用累积的 `raw`、只对当前 chunk 脱敏。
- B 的联测容忍而非强制隔离：`SOFT_ROUTES` 白名单意味着页面真的会去请求 Google Fonts；建议 `context.route('**')` 拒绝所有非 `127.0.0.1` 源。
- F 的 `mustNotAppear` 断言是重言式（前一行已断言 `items` 为空，`.some()` 恒假）；被拒 pin 免除了应召回项且 `refusedPins` 从不被断言；`ret-08` 的 KNOWN_GAPS 理由与夹具不符（该行只有一个条目且被拒，store 是**空**而非「无重叠」）；`preference` 类 6 行全期望 `preference`，无同类硬负例。
- `ids.js` 的 `legacy` 字段名与注释误导：上一代格式 `dec-<ts>-<8hex>` 会报 `legacy: false`。安全关键的 `hasCollisionResistantTail` 是对的，只是字段名骗人。
- `dispatch.js` 现在把**未脱敏**的原始任务交给 reviewer（台账预览是脱敏的，prompt 不是）。planner 与 implementer 本来就看得到，属扩大而非新类别，但应写进变更理由。
- D 的 `autoresearch-workspace.test.mjs` 把非 darwin 的硬断言改成分支，理由写的是「由 Linux runner 覆盖」——**本仓没有任何 CI 配置**（`.github/workflows` 不存在），该 runner 不存在。要么落地 runner，要么撤回理由并还原硬断言。
