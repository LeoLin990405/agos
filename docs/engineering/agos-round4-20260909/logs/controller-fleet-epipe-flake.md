# dsh-fleet farm EPIPE 红闸（V 权威门）

- 发现者：V（`4fd53669`），权威正式门 exit 1
- 处理：主控；只改 `plugins/dsh-fleet/test/farm-integration.test.mjs`
- 日期：2026-09-10

## 权威失败

`plugins/dsh-fleet/test/farm-integration.test.mjs:300`

`early ssh exit with a max-legal prompt is detached without an unhandled stdin EPIPE`

`waitUntil` 默认 2000ms 内 ledger 未见 `"ev":"detach"`。测试结束后 `t.after` 已 `rmSync` stub，异步预检再跑同一路径 → `unhandledRejection` / `No such file or directory`。

该文件不在本轮 A/B/C/D diff 里。V 随后单跑该文件 5/5 绿。

## 复现与排除

| 条件 | 结果 |
|---|---|
| 单文件默认并发 × 8 | 8/8 pass |
| 单文件 `--test-concurrency=1` × 5 | 5/5 pass |
| Node 26 默认 `--test-isolation` | **按进程**（两文件 PID 不同，PATH 不共享） |
| 同文件默认并发 | **已串行**（5×100ms ≈ 580ms 墙钟） |
| 正式门 argv（20 个 `.mjs`）× 3，修前 | 3/3 pass（未复现） |

跨文件 PATH 踩踏和同文件并发改 `process.env` **都不是**这次红闸的可复现机制。更像是全套件并行时 255→detach 的 ledger 写入偶发超过 2s 轮询窗；失败后立刻删 stub，把还在飞的预检暴露成二次噪音。

## 修改

1. 该用例（及同结构的 timeout-kill）`waitUntil` 上限 2s → 10s。产品契约未改：solo 仍约 400–600ms。
2. `t.after` 先 `hooks.cancel()` 并 `await run`，再 `dispose` / 还原 env / `rmSync`。

修后：单文件 5/5；正式门 argv × 3 全绿。

权威复跑（可代替「门仍红」这句话，**不能**代替 V 那次独立红闸记录）：

```bash
node scripts/acceptance/run-acceptance.mjs --with-frontend \
  --json=/tmp/agos-r4/logs/controller-recheck/acceptance.json \
  --logdir=/tmp/agos-r4/logs/controller-recheck/acceptance
```

exit **0**，`authoritative: true`，1252 / 1247 / 0 / 5。dsh-fleet 183 / 0 / 1 / 184。
JSON `sha256=6a16cd2d322bf8299d78f114c40cfc544a2b4aa9eaca7cd1f325ea903b9e70ff`。
