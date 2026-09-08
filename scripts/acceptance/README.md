# scripts/acceptance — 可复现依赖面 + 诚实验收入口

零模型调用、零私有语料、零供应商密钥、绝不写 `~/.dsh`。

| 文件 | 作用 |
|---|---|
| `measure-dependency-surface.mjs` | **A1** 实测每个插件套件的真实依赖面,产出 `dependency-surface.json` |
| `dependency-surface.json` | 机器可读清单:每个套件归类 + 每个套件真正需要的外部裸包 |
| `prepare-host-modules.mjs` | **A2** 隔离依赖树的核验与安装(带硬安全不变量) |
| `host-deps/layers.json` | 分层安装清单(为什么分层见文件内说明) |
| `run-acceptance.mjs` | **A3** 代码闸 / 部署漂移**分离**的验收器,产出机器可读 JSON |
| `expected-counts.json` | 计数下限基线(不在仓里时会告警;由 `--write-floors` 从全绿运行生成) |
| `selftest.mjs` | **A4** 负控:证明验收器没法谎报成功 |
| `mutation-check.sh` | 元证明:故意改坏验收器,证明上面的负控不是空转 |
| `selftest-fixtures/` | 负控固件(故意失败 / 0 测试 / 全 skip / 混合 / 漂移桩) |
| `artifacts/` | 最近一次真实运行的证据(JSON + 日志 + 负控输出) |

## 常用

```sh
# A1 实测依赖面(约 2 分钟,65 个套件 × 多种沙箱模式)
node scripts/acceptance/measure-dependency-surface.mjs

# A2 只核验不写
node scripts/acceptance/prepare-host-modules.mjs --check
# A2 不就绪就装(装进 scripts/acceptance/host-deps/,绝不写 ~/.dsh)
node scripts/acceptance/prepare-host-modules.mjs
# A2 离线 + 操作员显式点名从既有依赖树只读复制(没有默认路径)
node scripts/acceptance/prepare-host-modules.mjs --offline --copy-from="$HOME/.dsh/profiles/node_modules"

# A3 验收(代码闸决定退出码;部署漂移只报不参与)
node scripts/acceptance/run-acceptance.mjs --json=out.json
node scripts/acceptance/run-acceptance.mjs --with-frontend     # 加上 frontend npm run verify

# A4 负控 + 元证明
node --test scripts/acceptance/selftest.mjs
zsh scripts/acceptance/mutation-check.sh
```

## 三条不混的通道(A3)

- **codeGates** — 唯一决定进程退出码的东西。
- **advisory** — 部署漂移这类环境事实。真实退出码原样进 JSON 与终端(带 `ADVISORY` 标签),但**永不**参与退出码,也**永不**被吞。
- **preflight** — 依赖面预检。实测需要的包缺了 → 相关闸判 `missing-host-modules` **失败**(退出码 78),绝不降级成 skip。

## 诚实判定

| 情况 | verdict | 算绿? |
|---|---|---|
| 退出 0、有摘要、fail 0、tests>0、pass>0 | `pass` | ✅ |
| 退出非 0 / 报了 fail / 压根没有摘要 | `fail` | ❌ |
| 退出 0 但 tests 0 | `empty` | ❌ |
| 有测试但一条都没真过(全 skip) | `skipped` | ❌ |
| 测试数低于 `expected-counts.json` 下限 | `fail` | ❌ |

`skip` 数永远单列,**永不**并入 `pass`。

## 为什么要有计数下限

Node v26 的 `--test` 把一个**没注册任何测试**的文件本身算成 **1 个通过的测试**。
所以"清空测试文件"这种作弊,光看 `pass > 0` 抓不到 —— 只有对历史基线设下限才抓得到。
`selftest.mjs` 的 NC6b 把这个 Node 行为和下限闸的效果都钉住了。
