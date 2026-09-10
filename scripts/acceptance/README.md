# scripts/acceptance — 可复现依赖面 + 诚实验收入口

零模型调用、零私有语料、零供应商密钥、绝不写 `~/.dsh`。

## 文件

| 文件 | 作用 |
|---|---|
| `measure-dependency-surface.mjs` | 运行时观测每个插件套件的**分类**与**至少一个**缺失包,产出 `dependency-surface.json`(**不是完整依赖面**,见下) |
| `dependency-surface.json` | 机器可读快照:每个套件的分类 + 观测到的外部裸包 + `inputsDigest` 新鲜度指纹 |
| `prepare-host-modules.mjs` | 隔离依赖树的核验与安装(带硬安全不变量);`--check` 是**权威依赖面判定** |
| `host-deps/layers.json` | 分层安装清单(为什么分层见文件内说明) |
| `run-acceptance.mjs` | 代码闸 / 部署漂移**分离**的验收器,产出机器可读 JSON |
| `expected-counts.json` | 计数下限基线(不在仓里时会告警;只能由 `--write-floors=<路径>` 从全绿运行生成) |
| `host-integrations.json` | 宿主环境集成清单:声明"这个说明符在干净树里解析不到属预期"。检查器**不信任**它,逐条独立核验 |
| `verify-host-tree.mjs` | 隔离宿主依赖树的**本地未篡改**校验 + **版本一致性**校验 |
| `host-tree-digests.json` | 上一条的内容基准(那些"不可由 registry 精确复现"的包) |
| `selftest.mjs` | 负控:证明验收器**没法**谎报成功。每条控制都真把验收器当子进程跑一遍 |
| `mutation-check.sh` | 元证明:故意改坏验收器,证明上面的负控不是空转 |
| `selftest-fixtures/` | 负控固件(故意失败 / 0 测试 / 全 skip / 混合 / 漂移桩 / 环境卫生) |
| `lib/` | 共享实现:`exec.mjs`(跑子进程+解析摘要+诚实判定)、`import-graph.mjs`(**完整**静态导入图)、`surface-inputs.mjs`(依赖面新鲜度指纹)、`host-integrations.mjs`(集成清单核验与安全阀)、`safe-write-root.mjs`(写入目标真实路径守卫) |
| `test/` | 上面这些库自己的测试,外加 `mutation-counter-evidence.mjs`(计数类突变的元证明) |
| `integration/` | **第四轮新增**的集成层入口（`swarm/`、`linux/` 及共用矩阵）。用法与结果格式仍随第四轮修复冻结验收；当前 Linux 实测为 `blocked`，旧本地 swarm 运行记录来源不可审计。 |

> **注**:证据产物**不在本目录**。每一轮的原始日志与 JSON 收在
> `docs/engineering/<轮次>/logs/` 下,随该轮交付文档一起提交。
> (历史:早期版本曾在本目录规划过一个 `artifacts/`,**从未落地、也从未被 git 跟踪**。)

## 常用

```sh
# 依赖面测量(第四轮实测约 6.5 分钟;dependency-surface.json 记录的是 77 个套件 × 3 种沙箱模式)
node scripts/acceptance/measure-dependency-surface.mjs
#   ⚠️ 不带 --out= 时**默认覆写 tracked 的 dependency-surface.json**。
#   ⚠️ 必须在**冻结态**跑:源码正在被改动时,测出来的是移动靶。
node scripts/acceptance/measure-dependency-surface.mjs --out=/tmp/surface.json   # 测量但不动基线
node scripts/acceptance/measure-dependency-surface.mjs --plugin=dsh-fleet        # 只测一个插件

# 依赖树核验 / 安装
node scripts/acceptance/prepare-host-modules.mjs --check      # 只核验不写(权威依赖面判定)
node scripts/acceptance/prepare-host-modules.mjs              # 不就绪就装(装进 host-deps/,绝不写 ~/.dsh)
node scripts/acceptance/prepare-host-modules.mjs --offline --copy-from="$HOME/.dsh/profiles/node_modules"
#   ↑ 离线 + 操作员显式点名从既有依赖树只读复制(没有默认路径)

# 隔离宿主树校验
node scripts/acceptance/verify-host-tree.mjs

# 验收(代码闸决定退出码;部署漂移只报不参与)
node scripts/acceptance/run-acceptance.mjs --json=out.json
node scripts/acceptance/run-acceptance.mjs --with-frontend     # 加上 frontend npm run verify

# 负控 + 元证明
node --test scripts/acceptance/selftest.mjs
zsh scripts/acceptance/mutation-check.sh
node scripts/acceptance/test/mutation-counter-evidence.mjs
```

### `measure-dependency-surface.mjs` 的合法参数(**其余一律 exit 78**)

| 参数 | 作用 |
|---|---|
| `--out=<路径>` | 输出到别处。**不给就覆写 tracked 基线** |
| `--plugin=<名>` | 只测一个插件 |
| `--logdir=<路径>` | 原始日志目录 |
| `--no-shield` | 关掉 Seatbelt 沙箱(只跑 natural 模式) |

**未知参数会在测量之前 exit 78,并打印合法参数与危害说明。**
注意**必须带等号**:裸 `--out /tmp/x` 也是未知参数形态,同样 exit 78。

<details>
<summary>为什么要这道检查(第四轮实测事故)</summary>

参数解析原本是 `args.find(a => a.startsWith('--<name>='))`,只认 `--name=value` 一种形态,
其余**一声不响地落空**。而本脚本的**默认输出路径就是 tracked 文件**。

第四轮主控想看一眼当前指纹,敲了 `--print`(该脚本从来没有这个标志),
实际发生的是:跑完约 6.5 分钟全量测量,然后**覆写了版本控制里的基线**(471 增 / 338 删)。
更糟的是当时有四个实施代理正在并行改源码,那次测量观测的是移动靶,**数据本身也不可信**。

裸 `--out` 是同一缺陷里最阴的形态:操作者写 `--out /tmp/x` 以为把输出重定向走了,
旧代码里 `--out` 和 `/tmp/x` **两个都落空**,于是照默认路径覆写了仓库基线。

这与第三轮的裸 `--write-floors`(负控 NC19c)是同一类缺陷:**对无法识别的输入保持沉默,
然后做一件与操作者意图不同的破坏性事。** 区别是这次动的是 tracked 文件。

负控:`NC21`(五种未知形态 + 断言在任何测量输出**之前**退出 + 断言 tracked 基线一字节未变)、
`NC21b`(裸 `--out`)、`NC21c`(反反证:合法参数绝不能被误伤,否则"一律拒绝"也能全绿)。
完整记录见 `docs/engineering/agos-round4-20260909/REVIEW.md` §0。
</details>

## 依赖面:哪一个是权威的

这两者**不是一回事**,别混用(第三轮定的分工):

| | `dependency-surface.json` | `prepare-host-modules.mjs --check` |
|---|---|---|
| 怎么得到 | **运行时观测**:真跑 `node --test`,看它报哪个包找不到 | **静态遍历完整导入图**(`lib/import-graph.mjs`) |
| 能证明什么 | 每个套件在真实环境下过不过、是否依赖 `~/.dsh` 下的绝对路径 | 完整的外部裸包集合 |
| **不能**证明什么 | **不是完整依赖面**——Node 在模块图里遇到**第一个**未解析说明符就退出,所以一个套件一次最多暴露一个缺包 | — |
| 权威性 | 参考 | **权威** |

这个分工是第三轮的直接产物:上一轮的依赖面只有运行时观测,于是 `dsh-fleet` 只留下
`schemastery` 一条记录,而它在模块层还需要另外几个包——结果 `--check` 会在
"8 个套件其实都加载不了"的机器上报"依赖面就绪"并 exit 0。

`dependency-surface.json` 自己也这么说(见其 `method.doesNotProve` 字段),
它不是本 README 单方面的声明。

### 新鲜度指纹

`dependency-surface.json` 带一个 `inputsDigest`(覆盖各插件 `test/`+`lib/`、宿主树 `package.json`)。
内容一变,门会打印"依赖面产物已陈旧"并**不据此判任何套件失败**——权威判定在
`host-modules-check`(完整静态导入图)那一闸,它在门里、它会硬失败。

**为什么按内容而不按 `gitHead`**:产物自己要被提交,一提交 HEAD 就变,按 HEAD 判会
"永远陈旧",而陈旧时预检不再拦人 = 把这层检查永久关掉。`NC20f` 专钉这一点,别改回去;
`NC20g` 管另一头:旧格式产物(没有指纹)一律按陈旧处理,不许靠"缺字段"绕过判断。

## 三条不混的通道(`run-acceptance.mjs`)

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

第四轮起,集成层另有一个 `blocked` 判定(环境不具备,与被测代码无关)。
**`blocked` 同样不算绿,也绝不被汇总成"整体集成通过"**;它与产品代码结果**分开报**。
判定契约见 `docs/engineering/agos-round4-20260909/TASKS.md`。

## 为什么要有计数下限

Node v26 的 `--test` 把一个**没注册任何测试**的文件本身算成 **1 个通过的测试**。
所以"清空测试文件"这种作弊,光看 `pass > 0` 抓不到 —— 只有对历史基线设下限才抓得到。
`selftest.mjs` 的 NC6b 把这个 Node 行为和下限闸的效果都钉住了。

⚠️ 重算下限必须写成 `--write-floors=<路径>`:**裸 `--write-floors` 会 exit 78**
(第三轮修复,负控 NC19c —— 在那之前它被静默忽略,操作者以为下限已上调,实际一字未动)。
下限**只能从全绿运行生成**,且**只上调不下调**;合成/自定义计划运行会自报
`authoritative=false` 并**拒绝**写基线。
