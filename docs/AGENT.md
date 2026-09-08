# AgOS Agent 设计（2026-09-08）

本文是工程层、prompt、记忆、密门、分配的仓内真源。屏幕句子必须从数据算出。缺席写成未采集，不编零。

## 谁有权

操作员是执行权威。模型只提案。`POST /api/agos/routes/decide` 对 SPA 不可达。组装、影子路由、技能短名单、记忆回注都不换本跳会话模型，不自动起 swarm。

## 四段闭环（记忆 / 技能 / 模型分配共用）

1. **候选** — 本会话 store / 本跳 catalog / 角色模型池。不发明名单外 id。
2. **排序** — 词面（ASCII≥2，中文整词≥2，子串 `fold`⊂`folding`）+ Beta-Bernoulli 后验（κ=4，未上榜 prior=0.15）。丢掉 CJK 单字。技能目录另加 CJK 双字，因为 description 是短释义，整词对不上问句。无问句或零重合走重要度候补，必须写「不是相关性」。
3. **曝光** — 短名单 K=8。回注 / 目录裁剪 / 组装提案都是曝光，不是胜负。
4. **反馈** — 操作员确认后才写 JSONL。`skill()` 调用、回注曝光、三角色试跑都不是 ok/fail。

禁止 embedding、双塔、协同过滤、假 CTR。禁止把后验接入 live dispatch。

## 记忆

会话记忆是便利投影，不是 Fleet Memory。真源写入只走宿主 civ `memory_submit`；未接线必须 `CIV_UNAVAILABLE`，`fleetMemory: false`。`tools.invoke` 本身不算接线——必须 `get('memory_submit')` 命中，或 `has`/`list` 证明工具在场。`get()` 空命中不能挡住 `list`/`has`。AgOS 不写 `MEMORY.md`，不跑 `fleet-memory-push.sh`。

本跳证据按 lane 整段替换，写入 `turn-evidence.jsonl`。相关账本问句锁定本跳回注 query。甲板作废的 slug 不进工作集，也不钉上星图。抽取失败标 `degraded`，显示上次确认内容，不把失败写成空店。

## 密

一种分类，两种处置：

- **拒绝落盘** — 会话记忆、pin、路由预览。整条丢掉并计数，不存片段。
- **落盘前擦除** — fleet / route-outcome 台账。替换为 `«redacted»`，路径与环境名保留。

实现只在 `plugins/dsh-agos/lib/secrets-gate.js`。其它插件只 import，不准再叉一份更弱的正则。fleet dispatch / artifacts / ledger 都走同一把 `scrubString`。

## 分配

实现只在 `plugins/dsh-agos/lib/allocate-kernel.js`。技能 evolve、记忆短名单、组装 `rankAgents` 共用 `betaPrior` / `posteriorCounts` / `posteriorMean`。三本账本分开：`skill-allocate.jsonl`、`memory-relevance.jsonl`、`route-outcome.jsonl`。影子行不进分配后验。

## Prompt

实现只在 `plugins/dsh-agos/lib/agent-prompts.js`。所有模型提示词共用诚实前缀：只依据给定事实、不编名单外 id、不写 decide、缺席写成未采集。选择器、技能重排、技能目录 reminder、记忆回注 reminder、组装三角色、编队 guidance、自主优化子代理都从这里组装。实现被工具块挡下时去工具再试一次，再失败仍记失败，不编终稿。

## 明确不做

不训 Conductor / TRINITY。不把组装自动变成 swarm。不发明第一条胜负行。不把桌面 `.app` 当 0.1.2 runtime。
