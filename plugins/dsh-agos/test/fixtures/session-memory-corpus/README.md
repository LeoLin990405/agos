# W2 短期记忆抽取规则的尺(TASK-2026-08-22-017 W20 · 2026-08-23)

**先装尺再改规则。** 这里是标注语料 + 评分器 + `acceptEdit` 门;规则改动必须让 `test/session-memory-rules.test.mjs` 过。

## 语料来源(零编造)
- `mine.mjs` 从 `~/.dsh/sessions-trash-20260820`(392 会话)挖候选句:切分与敏感过滤**直接复用** `lib/session-memory.mjs` 的同一实现(`splitCandidatesForCorpus` / `isSensitiveMemoryText`),语料里的「句」就是规则看到的「句」。
- 三块:
  - `rpc`:`user/message` 且 `source` 带 `rpcId`(浏览器 / RPC 通道)——Leo 手敲 **或** 经 RPC 发出的探针(`scripts/smoke.ts:74` 的「请只回复两个字:收到。」就在这里,**与手敲同形,来源门挡不住**);294 句全标。
  - `bare`:`source` 只有 `{kind:'user'}`——子代理派发 prompt(depth 1)或 headless 直发探针(depth 0);按「不是 Leo 的话」**一律标 null**,量的是来源门。抽样 60 + 42。
  - `assistant`:depth 0 的助手句里含 rejected 线索词(改用/不支持/放弃…)的 43 句;只有**明确排除过的方案**标 rejected,过程叙述/能力限制都是 null(助手事实不可信,规则也只收 rejected)。
- held-in / held-out 按索引奇偶切,两侧都进门;assistant 单独报,不并入两侧计数。

## 标注口径(`label.kind` × `label.scope`)
- `constraint/persistent`:Leo 说的、超出本轮仍应成立的规矩(「不要在记忆库里写任何凭据」「MEMORY.md 只做索引」)。
- `constraint/turn`:只管本轮输出/工具/格式的指令(「只回复 done」「不要调用任何工具」「不要传 panel」、auto-continue 模板)。**规则把它抽成 constraint 就是误报**——这正是 TASK-009 定性的那类。
- `fact/persistent`:关于 Leo/项目/机器的可持久陈述(「我的是套餐」「Gen8 是服务面 + 存储面 + 记忆库权威」、机器 IP 行)。
- `preference/persistent`:「我更喜欢/希望…」。本语料里 0 条——不是口径漏了,是归档里没有。
- `rejected/persistent`:明确排除的方案(「试过 flock,macOS 没有」)。
- `null`:问句、口语、任务描述(「帮我看看…」)、片段(以冒号结尾的引子、围栏标记、命令行)、贴回来的工具报错、引用的别人文字。
- 任务描述 ≠ 约束:没有禁止/要求词的任务句是 null,不是 turn。

## 通过判定
一行 = 一个事件喂 `extractSessionMemory(events, {now, header})`,预测 kind 取产出 item 的 kind(无则 null)。
**期望 = scope 为 persistent 时取 label.kind,否则 null(turn 指令与 null 的期望都是「不抽」);pass = 预测 kind === 期望**。
另报每 kind 的 P/R/F1 与「imp=5 条目里 persistent 占比」,只看不进门。

## 门(`acceptEdit`,逐字移植 fugue self-harness-accept 的思路)
- `baseline.json` 存 `{inTotal,outTotal,inPass,outPass,assistant:{total,pass},corpusSha256,rulesNote}`;
- 语料 sha 或 total 变了 → 抛错(语料动了必须重跑基线);
- 任一侧 pass 下降 → 红;全部相等 → 绿;
- 有提升 → **红并提示** `SESSION_MEMORY_ACCEPT_BASELINE=1 node --test test/session-memory-rules.test.mjs` 重写基线——由人显式接受,测试不静默改文件。

## 第一次基线(现规则,2026-08-23)
见 `baseline.json` 与 017 执行日志。这就是「先看见误报率」。
