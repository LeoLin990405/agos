# 交接（第三轮 → 下一轮，2026-09-09）

## 位置

| 项 | 值 |
|---|---|
| worktree | `/Users/leo/Projects/agos-cursor-fix-20260909` |
| 分支 | `fix/cursor-integration-20260909` |
| 交付 | 该分支**尖端**；代码最后一跳 **`d60ae14`**，其后各跳只动 `docs/` |
| 基线 | `9434064f87b1a936c13c58b94c2473c6d89f3a61`（第二轮，未上传） |
| 状态 | **未 push、未合并 main、未部署、未重启用户 DSH** |

**测试数字全部量在 `d60ae14`**，它之后的提交只动 `docs/`（核对：`git diff --stat d60ae14 HEAD`
应当只见 `docs/` 下的文件）。代码提交四跳，新→旧：

```
d60ae14  依赖面预检认清单与内容指纹、Router 锁活性去负载耦合、Fleet 拒绝上报去顺序耦合、写路径剥 taskRef
b067830  验收器自测/正式门完整性、依赖可复现与安装路径安全、宿主联测判定与资源、会话删除判据、Fleet 远端产物
c38bd47  ← Kimi 3c61727（cherry-pick，零冲突）
3cfd497  ← 智谱 e6c1045（cherry-pick，零冲突）
```

---

## 怎么复跑

```bash
cd /Users/leo/Projects/agos-cursor-fix-20260909

# 正式门（权威口径，约 100 秒）
node scripts/acceptance/run-acceptance.mjs --with-frontend
#   期望：代码闸绿，pass 1054 / fail 0 / skip 8（tests 1062），exit 0

# 验收器自测（Luna 的 P1，约 13 秒）
node scripts/acceptance/selftest.mjs            # 期望 44/44 exit 0

# 负控的元证明：把验收器改坏，看负控抓不抓得到（约 30 秒）
node scripts/acceptance/test/mutation-counter-evidence.mjs   # 期望 23/23

# 真实宿主浏览器联测（约 4 分钟，需要 Chrome）
node frontend/tests/host-integration/run.mjs
#   期望：9 passed / 0 failed / 0 blocked / 0 skipped
```

### 干净依赖树复现

```bash
CLEAN=$(mktemp -d) && cp plugins/package.json plugins/package-lock.json "$CLEAN/"
cd "$CLEAN" && npm ci        # 期望 exit 0，31 包，无 --force / --legacy-peer-deps
npm ls --depth=0             # 期望 exit 0，无非 optional 的 UNMET/invalid
```

---

## 会绊到你的三件事

### 1. 联测需要**隔离的** Playwright，而且它会拒绝借用你的 profile

这是有意的：harness 的契约是「绝不读 `~/.dsh`」，而它原先的默认解析路径正是
`~/.dsh/profiles/web/node_modules/playwright-core`。现在解析顺序是
**显式参数 → 仓库自有依赖树 → 大声 `blocked`**。

本轮已给 `frontend` 装好钉死的 `playwright-core@1.62.1`（registry，无 `--force`），
所以开箱可用。若你在别的机器上跑到 `IntegrationBlocked: no Playwright available`，
装进仓库自己的树，或设 `AGOS_PLAYWRIGHT_MODULE` 指向隔离安装——
**不要**指向 `~/.dsh`（真要这么干得显式设 `AGOS_ALLOW_LIVE_PROFILE=1`，届时会有警告）。

浏览器可执行文件从系统里找（Chrome / Chromium），**从不下载**；找不到设 `AGOS_BROWSER_EXECUTABLE`。

### 2. 改了 `plugins/**` 之后，依赖面产物会自报陈旧

`dependency-surface.json` 带一个 `inputsDigest`（覆盖各插件 `test/`+`lib/`、宿主树 `package.json`）。
内容一变，门会打印：

```
⚠️  依赖面产物已陈旧(测量时的输入指纹 … ≠ 当前 …)—— 它描述的可能是另一棵树，
   故本次**不据此判任何套件失败**;权威判定见 host-modules-check(完整静态导入图)那一闸。
```

这不是错误，是提醒。重测（慢，要跑全部套件三种模式）：

```bash
node scripts/acceptance/measure-dependency-surface.mjs
```

**为什么按内容而不按 `gitHead`**：产物自己要被提交，一提交 HEAD 就变，
按 HEAD 判会「永远陈旧」——而陈旧时预检不再拦人，等于把这层检查永久关掉。
`NC20f` 专钉这一点，别改回去。

### 3. `dsh-kimicode-swarm` 不在依赖树里，这是设计

它是**宿主环境集成**，在 `scripts/acceptance/host-integrations.json` 里逐条声明。
干净树里解析不到属预期，门会点名豁免：

```
宿主环境集成(清单已声明,干净树里解析不到属预期,不判失败): dsh-kimicode-swarm
```

代价是 5 项 skip（cn-capabilities ×4、dsh-fleet ×1）。要恢复覆盖：

```bash
AGOS_SWARM_MODULE=/path/to/usable/swarm  npm test
```

理由（逐版 `npm pack` 实测）见 [REVIEW.md 三](REVIEW.md)。
**不要**为了消掉这 5 项 skip 就把 swarm 加回 `plugins/package.json`——
那会把 `dsh-settings` 拽回 rc.6，整棵树重新装不出来，这是上一轮的坑。

---

## 下一轮建议先做的

按我的优先级：

1. **Linux 上验一遍。** 本轮无真实环境，弱后端保持拒绝但**未经验证**。
   Kimi 已移除 `buildUnshareArgs` 并以 `=== undefined` 钉死，需要在真 Linux 上确认
   bubblewrap 路径的两个运行时探针（exit 93 绑宿主 sentinel 可读 / exit 94 loopback 可达）真的成立。
2. **把两个依赖 `~/.dsh` 绝对路径的套件改造成注入式**
   （`dsh-agos-router/http-routes.test.mjs`、`index-async-wiring.test.mjs`）。
   装包解决不了，门只能如实点名。属 Router 所有权。
3. **`prepare-host-modules` 的 TOCTOU 残留窗口**：当前是 `O_NOFOLLOW` +
   打开后复核 `st_dev`/`st_ino`，不是零窗口。若平台允许，改成对已打开的目录描述符做
   `openat` 链会更彻底。
4. **独立审查。** 本轮的 REVIEW.md 是自证。[REVIEW.md 六](REVIEW.md)
   列了「如果我是审查者会先查的五处」，每处都写明了「改坏它，哪条测试该变红」。

---

## 硬规矩（沿用，别破）

- 计数下限**只能从全绿运行生成**（`--write-floors` 会拒绝红状态），**只上调不下调**。
  本轮从 172/124/148/37 上调到 194/156/176/44，无一下降。
- 合成运行（用了 `--required-plugins`/`--plugins-root`/`--selftest-file`/`--surface`/
  `--host-integrations`）自报 `authoritative=false` 且**拒绝写基线**——防假套件树洗掉真基线。
- 私有语料**不为过门去读**。3 项 skip 如实留着。
- 交付日志经过**一次**路径前缀替换（`<HOME>`/`<REPO>`/`<TMP>`），
  口径写在每份文件头部三行；`SHA256.txt` 里的摘要是**脱敏后**文件本身的。
  不要「隐改日志又沿用旧 hash」——上一轮独立验证者就是抓的这一条。

---

## 交付物清单

```
docs/engineering/agos-fix-20260909/
├── TASKS.md          八项 + 新暴露三项的台账，每条带判据与否证
├── REVIEW.md         判断依据、反对意见、我认为最该被质疑的地方
├── VERIFICATION.md   全部实测数字；文末单列已作废的历史结论
├── HANDOFF.md        本文件
└── logs/
    ├── SHA256.txt              摘要针对脱敏后的文件本身
    ├── acceptance-gate.txt     正式门，exit 0
    ├── selftest.txt            44/44（Luna 核查时 1 pass / 13 fail）
    ├── acceptance-unit.txt     64/64
    ├── mutation-meta.txt       23/23 突变全被抓
    ├── clean-npm-ci.txt        npm ci exit 0，31 包
    ├── host-integration.txt    9 passed / 0 blocked / 0 skipped
    └── suite-*.txt             六套件
```

**未宣布全部验收通过**——按任务书，等独立审查与最终生产接线验证。
