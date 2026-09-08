# AgOS round 2 — 所有权、依赖图与实际 agent 调用

状态：进行中。本文件由主控单写。

- 仓库：https://github.com/LeoLin990405/agos
- 基线提交：`7e7e359801644b77b302835f374f035e2836926d`（分支 `cursor/agos-hardening-20260908`，上一轮已验收）
- 本轮 worktree：`/Users/<name>/Projects/agos-round2-20260908`
- 本轮分支：`cursor/agos-round2-20260908`（新建，`git worktree add -b`，从上述精确提交切出，未从 main 切）
- 上一轮已验收工作区 `/Users/<name>/Projects/agos-cursor-hardening-20260908` 与原始主仓 `/Users/<name>/Projects/agos` 本轮均未改动

上一轮的 833/0/3 是上一轮的数字，本轮不复用。本轮自己的基线见 [VERIFICATION.md](VERIFICATION.md) 的「本轮基线」一节。

## 文件所有权表

单 writer 原则：下表每一行只有一个 writer。任何人不得回滚他人改动，不得在本 worktree 执行 `git commit/checkout/reset/stash/clean/restore`。

| 所有者 | 可写范围 | 明确排除 |
|---|---|---|
| 主控 | 所有 `plugins/*/lib/index.js`；`plugins/package.json`；`plugins/*/package.json`（依赖段）；`frontend/package.json`、`frontend/package-lock.json`、`frontend/tsconfig.json`、`frontend/UPSTREAM.pin`、`frontend/contract-baseline.sha256`；`scripts/` 下已有脚本；`docs/engineering/agos-round2-20260908/*.md`；生产构建产物 | — |
| A | 新建 `scripts/acceptance/**` | 依赖与 CI 变更交主控 |
| B | 新建 `frontend/tests/host-integration/**`、`frontend/scripts/host-integration/**` | `frontend/src/**` 只能提接线申请；不得 `npm run build` |
| C | `plugins/dsh-agos-router/**` | `lib/index.js` |
| D | `plugins/cn-capabilities/lib/autoresearch-*.mjs` 及其测试 | `lib/index.js`、council-*/plan-*/usage 及其测试 |
| E | `plugins/dsh-fleet/**` | `lib/index.js` |
| F | `plugins/dsh-agos/**` | `lib/index.js` |
| 契约研究者 | 只读，零写入 | — |
| 审查者 ×2 | 只读，零写入 | — |
| 验证者 | 只读 + 临时目录，零仓内写入 | — |

各实施者的接线建议写在自己独占的 `docs/engineering/agos-round2-20260908/wiring/<字母>-wiring.md`，由主控串行整合进 `lib/index.js`。

## 依赖图

```
契约研究者(只读) ──► B(需要 dsh 隔离启动参数)
                └──► A(需要宿主包公网可得性结论)

主控依赖树(plugins/package.json + plugins/dsh-mcp-bridge/package.json)
  └──► C、D、E、F 的完整套件才能跑起来(纯净 checkout 无 node_modules 时四个套件直接 fail)

C(lib/task-fingerprint.mjs 契约) ──► E(dsh-fleet 从 router 导入该 helper)

A、B、C、D、E、F 的 wiring/*.md ──► 主控串行整合 lib/index.js ──► 审查者复核生产接线 ──► 验证者独立全套件
```

跨包耦合点，本轮必须协调而非各自改：
1. `plugins/dsh-agos-router/lib/task-fingerprint.mjs` 由 C 拥有，`plugins/dsh-fleet` 导入。C 若改契约，E 侧需同步，由主控串。
2. 宿主包版本由主控统一钉。任何实施者不得自行 `npm install` 到 `~/.dsh/profiles/**`。

## 实际 agent 调用

并发槽位实际使用：主控 1 + 实施者 6 + 契约研究者 1 同时在跑；审查者 2 与验证者 1 在接口成形后启动（滚动调度，非同时 11 个）。下表只记真实发起的调用，不虚报。

| 角色 | subagent 类型 | 包 | 状态 |
|---|---|---|---|
| 实施者 A | shell | 可复现依赖与验收入口 | 运行中 |
| 实施者 B | generalPurpose | 真实定版宿主与浏览器联测 | **已完成**：真宿主 + 真浏览器 9/9；场景 8 首轮夹具超时，自行按主控诊断修好并自报证明范围比标题窄 |
| 实施者 C | generalPurpose | Router 持久化与反馈完整性 | **已完成**；接线由主控应用（见下） |
| 实施者 D | generalPurpose | Linux 自动研究验证沙箱 | **已完成**；Linux 未动态验收，如实 `verification-unavailable` |
| 实施者 E | generalPurpose | Fleet 远端产物路径竞争 | **已完成**，无需主控接线 |
| 实施者 F | generalPurpose | 合成中文记忆评估与来源一致性 | **中途终止**，留下机械损坏文件；主控已修复并留证（见 REVIEW.md）|
| 实施者 F2 | generalPurpose | F 剩余范围：同名同描述技能来源 / turn-evidence 保留 / 交接报告 | **已完成**：turn-evidence 审计后**不加清理**（理由充分），六项边界由 7 个测试钉住 |
| 契约研究者 | explore | 固定宿主真实 API 与能力 | **已完成**，结论与主控的一处修正见 REVIEW.md |
| 审查者 1 | generalPurpose | 执行/持久化（C、D、E） | 首轮只读已发起 |
| 审查者 2 | generalPurpose | 前端/协议（A、B、F、共享入口与依赖）| 首轮只读已发起 |
| **接线审查者** | generalPurpose | **专审主控自己的生产接线与修复**（router 事务接线、计划文件名、F 文件修复、文档诚实度）| 运行中 |
| 验证者 | generalPurpose | 独立复算全部数字、抖动排查、逐个反证负例、隐私与边界审计 | 运行中 |

前两名审查者是在主控接线**之前**派出的，因此按本轮规则「必须复核主控完成后的生产接线」，另派了一名接线审查者专审主控改动。主控不自审自己的接线结论。

## 主控实际改动（不只是接线）

| 文件 | 改动 | 缘由 |
|---|---|---|
| `plugins/dsh-agos-router/lib/index.js` | 应用 C 的四处事务接线 | C 的 helper 不接线则生产完全不受保护 |
| `plugins/dsh-agos-router/test/index-transaction.test.mjs` | **新建** 4 项 | 接线原本零覆盖：改成直通后全套件仍 116/116 |
| `plugins/cn-capabilities/lib/index.js` | 计划文件名加抗碰撞尾（**4 处**） | 实测抖动 108/0、108/0、107/1；修后交付树 5 × 114/0 |
| `plugins/cn-capabilities/test/plan-filename-collision.test.mjs` | **新建** 6 项 | 防回退：真实生产路径断言 + 四形状源码扫描 + 随机尾熵下限 |

> **校正记录（2026-09-09）**：上面两格原先写「3 处」「5 项」，是**中途数字**。「3 处」恰好是接线审查者发现我漏修第四处之前的那个数 —— 也就是说这份表当时记录的是一个已知不完整的状态，而它读起来像是终态。「5 项」同理，少了后来补的源码扫描那条。由独立验证者（VERIFY-FINAL.md 阻塞项 4）指出。终值：生成点 4 处，该测试文件 6 项。
| `plugins/dsh-agos/test/session-memory-zh-eval.test.mjs` | 修复 F 遗留的机械损坏 + 自指假阳性 + 加哨位负控 | F 中途终止，原所有者已不存在 |
| `plugins/package.json`、`plugins/dsh-mcp-bridge/package.json`、两个锁文件 | 可复现隔离宿主依赖树 | 摆脱指向个人 profile 的软链 |
| `docs/engineering/agos-round2-20260908/**` | 全部交付文档与日志 | 主控单写 |

`frontend/src`、`frontend/package.json`、锁文件、`tsconfig` 本轮**未改动** —— C 自行保住了前端契约，B 的夹具是 `.mjs` 不进 tsc 图。

主控在 F 终止后接手了 `plugins/dsh-agos/test/session-memory-zh-eval.test.mjs` 的修复（原所有者已不存在），F2 接手后该文件所有权移交 F2；主控不再写它。

## 验收清单

每包必须交出：修改文件、实际行为、公开入口接线、命令、真实退出码、通过/失败/跳过数量、日志路径、未解决风险。

| 编号 | 验收项 | 判定标准 |
|---|---|---|
| 1 | 依赖可复现 | 不经 `~/.dsh/profiles` 软链即可装齐宿主包，锁文件可 `npm ci` 复现 |
| 2 | 代码门与部署漂移分离 | 部署漂移 exit 1 不能污染代码门，也不能被静默吞掉 |
| 3 | 真实宿主 E2E | 真实 pin 宿主 + 真实浏览器 + 真实 transport + 真实 store；否则明确标未验收 |
| 4 | Router 跨进程一致性 | 真实多进程竞争 + SIGKILL，不丢记录、不破坏新 owner |
| 5 | 原始任务身份绑定 | 跨任务 verdict 与重放被拒，各有负例 |
| 6 | Linux OS 隔离 | 能力检测明确；无 Linux 环境时维持 `verification-unavailable` 且不谎报 |
| 7 | macOS 真实子进程隔离 | 上一轮 7 项行为保持，含超时无遗留子进程 |
| 8 | Fleet 产物路径竞争 | 校验与打开绑定同一 file object；三类替换攻击均不读到根外内容 |
| 9 | 中文记忆评估 | 抽取/来源/召回三份独立报告；不改标签掩盖回归 |
| 10 | 上一轮回归全保 | shadow 一对一、完整任务 SHA256、服务端来源、posterior gate、跨时区 owner、取消清理占槽 |
| 11 | 独立审查 | 两名非作者审查者复核 `lib/index.js` 生产接线，不只审 helper |
| 12 | 交付诚实 | 不用「进程 exit 0」「subagent 已完成」或旧测试数字代替验收结论 |
