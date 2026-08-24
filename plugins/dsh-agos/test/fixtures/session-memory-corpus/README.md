# 会话记忆抽取的尺(labeled-corpus ruler)

**先装尺再改规则。** 这里是评分器 + `acceptEdit` 门 + 基线;抽取规则的任何改动必须让 `test/session-memory-rules.test.mjs` 过。
语料由 `mine.mjs` 在本机从会话归档生成(`~/.dsh/agos-private/session-memory-corpus/` 或 `SESSION_MEMORY_CORPUS_DIR`),不随仓分发;语料缺席时本套测试自动跳过,`known-misreports.jsonl` 与 `baseline.json`(读数与逐条通过集合)随仓提供,口径可复核。

## 语料来源(零编造)
- `mine.mjs` 从 `~/.dsh/sessions-trash-20260820`(392 会话)挖候选句:切分与敏感过滤**直接复用** `lib/session-memory.mjs` 的同一实现(`splitCandidatesForCorpus` / `isSensitiveMemoryText`),语料里的「句」就是规则看到的「句」。
- 四个块,各自报数、各自进门:
  - `rpc.jsonl`(294):`user/message` 且 `source` 带 `rpcId`(浏览器 / RPC 通道)——用户手敲 **或** 经 RPC 发出的自动化探针(与手敲**同形,来源门挡不住**,只能靠单轮指令否决);全标。
  - `bare.jsonl`(102):`source` 只有 `{kind:'user'}`——子代理派发 prompt(depth 1)或 headless 直发探针(depth 0);按「不是用户本人的话」**一律标 null**。**它只证明来源门在**,不进规则精度的分母。
  - `known-misreports.jsonl`(8):部署环境里真实产生过的 8 条误报(单轮工具指令被当成持久约束),标 `constraint/turn`。这是规则改动的验收对象,尺必须盯着它。
  - `assistant.jsonl`(43):depth 0 的助手句里含 rejected 线索词的;只有**明确排除过的方案**标 rejected(2 条)。**n=2,规则在这上面不可评估**,召回 0 如实报。

## ⚠️ 局限(对抗验证 2026-08-23 逼出来的,读数时要记得)
1. **没有泛化估计。** 294 句 rpc 里 194 句来自同一个会话(那份 homelab 交接 prompt),所有 persistent 标签都在里面;按会话切分做不出独立的 held-out,行级奇偶切分只是把兄弟行分到两边(第一版就这么干了,已撤)。所以读数是**语料内拟合度**,不是精度估计。
2. **规则作者读过全部标签。** 正则里的否决词是看着语料写的;`known-misreports` 块是唯一一批规则作者在写规则前没拿来调参的样本(它来自现网不是归档)——它的读数最有信息量。
3. 来源门按「带 rpcId」放行:上游还有三条人手通道写裸 source(`/plan` 消息、ACP 编辑器桥、SDK server),本门**有意放弃**它们——经 `/plan` 通道下的规矩不会进会话记忆。归档里 57 条 depth-0 裸 user 实测全是 headless 探针。
4. 「不要改文件」「不要改任何文件」这两个形态,文本上与真规矩不可分;known-misreports 里它们仍会被抽成 constraint(5/8 通过就是这三条在失败)。靠文本分不开的,不装能分开。

## 标注口径(`label.kind` × `label.scope`)
- `constraint/persistent`:用户说的、超出本轮仍应成立的规矩(「不要在记忆库里写任何凭据」);**表达长期架构决策的陈述也算**,哪怕没有要求词。
- `constraint/turn`:只管本轮输出/工具/格式的指令(「只回复 done」「不要调用任何工具」「不要传 panel」「先用 bash 执行 sleep 20,不要并行」、auto-continue 模板)。**规则把它抽成 constraint 就是误报**。
- `fact/persistent`:关于用户/项目/机器的可持久陈述(套餐、机器分工、`机器:IP` 行、流程步骤里的分工陈述)。
- `preference/persistent`:「我更喜欢/希望…」。本语料里 0 条——不是口径漏了,是归档里没有。
- `rejected/persistent`:明确排除的方案(「试过 flock,macOS 没有」)。
- `null`:问句、口语、任务描述(「帮我看看…」)、片段(以冒号结尾的引子、围栏标记、命令行)、贴回来的工具报错、引用的别人文字。
- 任务描述 ≠ 约束:没有禁止/要求词、也不是长期决策的任务句是 null,不是 turn。

## 通过判定
一行 = 一个事件喂 `extractSessionMemory(events, {now, header})`,预测 kind 取产出 item 的 kind(无则 null)。
**期望 = scope 为 persistent 时取 label.kind,否则 null(turn 指令与 null 的期望都是「不抽」);pass = 预测 kind === 期望**。
另报每 kind 的 P/R 与「imp=5 条目里 persistent 且正确的数」,只看不进门。

## 门(`acceptEdit`)
- `baseline.json` 存每块 `{total, pass, passIds}` + `corpusSha256` + `rulesNote` + `acceptedRegressions`。
- 语料 sha 或 total 变了 → 抛错(语料动了必须先重跑基线,且要另给 `SESSION_MEMORY_ACCEPT_CORPUS=1`);
- **任何一条原来通过的样本变失败 → 红**,不允许用别处的提升抵消;
- 有新增通过 → 红并提示用 `SESSION_MEMORY_ACCEPT_BASELINE=1 SESSION_MEMORY_RULES_NOTE="…"` 重写基线(必须带 note);
- 有意的取舍(去掉一个关键词丢掉一条真规矩)要用 `SESSION_MEMORY_ACCEPT_REGRESSIONS="rpc:rpc-265,…"` 逐条点名,会记进 `acceptedRegressions`。

## 读数(见 baseline.json 与 017/021 执行日志)
- 改动前规则:rpc 207/294(constraint P=0.29)· bare 88/102 · known-misreports **0/8** · assistant 41/43。
- 对抗验证后版规则:rpc 266/294(constraint P=0.80 R=0.71,fact P=0.76 R=0.62)· bare 102/102 · known-misreports **5/8** · assistant 41/43(rejected R=0,如实)。有意放弃 rpc-265(去「需要」)。
