# 第四轮任务表（2026-09-09）

## 基线

| 项 | 值 |
|---|---|
| 工作区 | `/Users/leo/Projects/agos-cursor-fix-20260909` |
| 分支 | `fix/cursor-integration-20260909` |
| 接收到的 HEAD | `cf5ee889da1f481323e7e3ecd9bea188d3ad647b` + 10 个未提交修改 |
| **本轮基线提交** | **`745a0a6`**（把那 10 个已验收修改落成提交，内容零改动） |

基线核对（三重，全部通过）：

- HEAD 与验收记录一致；
- `git diff` 快照 sha256 `774cfefc32051fd196870189c0a7b94c1dfb786dedee46ba4626a889a4901589`，与
  `LUNA-EXECUTION-ACCEPTANCE.md` 记录逐字符相同 → 工作树与验收时**逐字节相同**；
- 596 个 tracked 文件逐文件 sha256 对照 `phase3/pre-tracked-sha256.txt`，**0 不一致 / 0 多出 / 0 缺失**。

第三轮结果属**历史基线**（1074 tests / 1069 pass / 0 fail / 5 skip），不复制为本轮结果。

## 环境探测（本轮开工时实测，是 A/B 可行性的前提）

| 能力 | 实测 | 影响 |
|---|---|---|
| 平台 | `Darwin 25.5.0 arm64` | Linux 层无法本机实跑 |
| 容器/VM 运行时 | docker / podman / lima / colima / orbstack / vagrant / multipass / qemu **全部缺失**；docker 守护进程不可用 | **B 的真实运行时 blocked**；装 VM 属"安装系统服务"，被执行约束禁止 |
| `bwrap` / `unshare` | 均不存在（macOS 本就没有） | 同上 |
| 真实 swarm | `/Users/leo/Projects/agos-round2-20260908/plugins/node_modules/dsh-kimicode-swarm`，`0.1.0`，`lib/index.js` sha256 `0a912120a30728164b5d8155544468dc…` | **A 可做真实集成**：实测 `import()` 成功（42ms），`runNormalizedBatch`（3 形参）、`publishProgress`、`SwarmScheduler`、`PROGRESS`、`STOPPED`、XML 四函数全部为可用导出 |
| registry swarm | 仅 `0.1.0 / 0.1.1 / 0.1.2` | 第三轮已实测其不导出所需符号；本轮**不**因此改依赖树 |

## 分工与文件所有权

**实际使用的模型**：全部 subagent 以 `inherit` 启动，即与主控同一模型（Claude Opus 5）。
本轮**没有**调用 gpt-5.6-luna、Gemini、国产分身或任何外部供应商模型。第三轮的
Luna 结果是历史记录，不是本轮执行。

| 代理 | 目标 | 可写文件 | 依赖 |
|---|---|---|---|
| **A** | 真实 swarm 集成 | `plugins/dsh-agos/lib/swarm-host-integration.mjs`、`plugins/cn-capabilities/test/plan-run.fake.test.mjs`、`plugins/dsh-fleet/lib/fleet-swarm-compat.mjs`、`plugins/dsh-fleet/test/swarm-compat.test.mjs`、新增 `scripts/acceptance/integration/swarm/**` | 无 |
| **B** | Linux 隔离入口 | `plugins/cn-capabilities/lib/autoresearch-sandbox.mjs`、`plugins/cn-capabilities/test/autoresearch-sandbox.test.mjs`、新增 `scripts/acceptance/integration/linux/**` | 无 |
| **C** | 宿主联测可移植性 | `frontend/scripts/host-integration/**`（README 除外）、`frontend/tests/host-integration/**`；**不改** package 文件 | 无 |
| **D** | 验证矩阵与证据 | 新增 `scripts/acceptance/integration/` 的共用入口/格式/测试（**排除** `swarm/` `linux/` 子目录） | 契约见下（已定死，无需协商） |
| **E** | 文档与交付 | `docs/engineering/agos-round4-20260909/**`、`scripts/acceptance/README.md`、`frontend/scripts/host-integration/README.md` | 结论待 A–D |
| **R1** | 只读复审 A/B 的实现与负例 | 仅报告 | A、B |
| **R2** | 只读复审 C/D 的实现、隔离与结果真实性 | 仅报告 | C、D |
| **V** | 冻结后独立最终检查 | 仅日志与验证报告 | 全部 |

**主控独占**（任何代理不得写）：所有 `package.json` / `package-lock.json`、各插件 `lib/index.js`、
`scripts/acceptance/run-acceptance.mjs`、`scripts/acceptance/selftest.mjs`、
`expected-counts.json`、`host-integrations.json`、其他共享入口。

## 结果格式契约（主控定，A/B/C/D 一律遵守）

每个集成层入口写一份 JSON 到 `<logdir>/<layer>.json`：

```jsonc
{
  "schema": "agos-acceptance/integration-layer@1",
  "layer": "swarm" | "linux" | "host-browser" | "code-gate",
  "verdict": "pass" | "fail" | "blocked" | "skipped",   // blocked ≠ pass，绝不合并
  "sourceCommit": "<git rev-parse HEAD>",
  "worktreeDigest": "<tracked 文件内容摘要；dirty 时必须变>",
  "command": ["node", "..."],                            // 实际执行的 argv
  "startedAt": "ISO8601", "endedAt": "ISO8601", "exitCode": 0,
  "platform": { "os": "darwin", "release": "25.5.0", "arch": "arm64", "node": "vXX" },
  "moduleProvenance": [                                  // 真实模块来源，A 必填
    { "specifier": "dsh-kimicode-swarm", "resolvedPath": "...", "version": "0.1.0",
      "sha256": "...", "origin": "local-build|registry", "originNote": "..." }
  ],
  "counts": { "pass": 0, "fail": 0, "skip": 0, "blocked": 0 },
  "blockedReason": null,                                 // verdict=blocked 时必填且具体
  "recoveryCommand": ["..."],                            // blocked 时给可复制的恢复命令
  "logs": [ { "path": "...", "sha256": "..." } ]         // 哈希必须实际计算
}
```

硬规则：

1. `verdict: "blocked"` **绝不**可被上层汇总成"整体集成通过"。
2. 缺少可选层**不得**报成产品代码失败——代码结果与集成覆盖状态**分开报**。
3. 日志 SHA256 必须实际计算，禁止手填或猜测。
4. 入口自检（可用桩成功 / 故意损坏桩失败）必须**标明是入口自检**，不得冒充真实集成 pass。

## 执行约束（所有代理）

- **保留继承的 `HOME` / `CODEX_HOME`**——连显式设回原值也不做。用 `mkdtemp` 和任务专用
  `DSH_HOME` 等参数隔离。
- 不读私人 corpus / 认证材料，不调真实供应商模型，不改线上 profile / 生产 Fleet / 服务器。
- 新安装只在本轮新建临时目录进行。禁止 `npm --force` / `--legacy-peer-deps` / 改共享 `node_modules`。
- 有其他代理并行工作：**不得回滚他人修改**。跨所有权改动交主控协调。
- 发现问题先给**具体触发条件与最小复现**，再修。新增分支必须实际走到。
  不把推测写成已发生事故。
- 原始日志一轮一目录，不覆盖失败日志。
