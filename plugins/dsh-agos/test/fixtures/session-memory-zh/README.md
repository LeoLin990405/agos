# 中文会话记忆的公开合成语料(synthetic, publishable)

**这批语料 100% 由本包作者手写编造,可以公开发布。** 与 `../session-memory-corpus/`
(Leo 真实会话,私有,缺席即跳过)是两回事,不要混用、不要互相当基线:

| | `session-memory-corpus/` | 本目录 `session-memory-zh/` |
|---|---|---|
| 来源 | 真实会话归档,`mine.mjs` 本机挖矿 | 作者手写编造 |
| 是否随仓分发 | 否(只留 8 条现网误报 + baseline) | 是,全量 |
| 缺席时 | 整套测试 skip | 不会缺席 |
| 量 | 447 句 | 见下表 |
| 用途 | 语料内拟合度 + acceptEdit 门 | 九类语义边界的**行为规格** |

## 合成保证(privacy)
- 无真人姓名:出现的人一律是「同事 / 客户 / 群里」这类角色词。
- 无真实主机名 / IP / 内网地址:域名只用 `example.invalid`(RFC 2606 保留,永不可解析),
  机器名只用 `M4-Demo`、`NAS-Demo` 这类明写 demo 的假名。
- **无任何凭据。** 敏感类样本靠「关键词 + 中文占位词」触发 `secrets-gate`,占位词一律是
  `占位口令示例请勿使用` 这种自我声明的中文短语,不含 `sk-` / `ghp_` / `AKIA` / JWT
  / base64 高熵串,不存在被误认成真 key 的形状。
- 本目录不读取、不引用任何用户目录;评测器只读本目录里的 jsonl。

## 三份评测,三份读数(不混成一个分)
`../session-memory-zh-eval.test.mjs` 分开报三件事,任何一件都不许用另一件的提升去抵消:
1. **抽取正确性** `extraction.jsonl` → `extractSessionMemory`
2. **来源判定** `provenance.jsonl` → `isDirectUserSource` + `catalogEntryOrigin`
3. **召回** `retrieval.jsonl` → `proposeSessionMemory`

## 九类与期望(`expect.kind` = 应当抽成什么,`null` = 不该抽)
| category | 中文 | 期望 | 理由 |
|---|---|---|---|
| `question` | 问句 | `null` | 问句不是事实,更不是规矩 |
| `quotation` | 引用 | `null` | 别人的话不是用户自己的偏好 |
| `negation` | 否定 | `constraint` 或 `null` | 持久的「不要 X」要收,且**存下来必须仍带否定词**;只管本轮的不收 |
| `conditional` | 条件 | `null` | 「如果…就…」是条件句,不是无条件事实 |
| `oneshot` | 一次性指令 | `null` | 本轮输出 / 工具指令不是长期偏好 |
| `preference` | 持久偏好 | `preference` | 该收 |
| `correction` | 纠正 | `fact` | 收新值;旧值的处置见召回评测 |
| `outdated` | 过时信息 | `null` | 带「以前 / 旧版 / 当时」的陈述不是当前事实;系统没有 stale 标记通道,所以只能不收 |
| `sensitive` | 敏感信息 | 整条拒收 | `expect.sensitive=true`:0 条产出 + `skippedSensitive≥1`,**不留片段** |

### 字段
- `expect.kind` — 应当产出的 kind,`null` 表示不该产出任何条目。
- `expect.scope` — `persistent` / `turn` / `null`,只做说明,不参与判定。
- `expect.sensitive` — `true` 时判定改为「0 条产出且 skippedSensitive≥1」。
- `expect.ambiguous` — `true` 表示**诚实的两难**:两种标法都说得通。这些行**不进 pass/fail 分母**,
  单独报「ambiguous」一节。诚实优先:不许为了让数字好看把难例标成 ambiguous——
  ambiguous 的每一行都写了 `why`,说明两种读法各自的道理。
- `mustContainInText` — 抽到的条目正文必须包含这些子串(否定类用它钉「不要」不能被吞掉)。
- `mustNotAppear` — 任何产出条目的正文都不许包含这些子串(敏感类用它钉「不留片段」)。

## 改这批语料的纪律
- **发现规则错了,改规则或如实报错,绝不回头改 label。** 把难例的 label 改成「代码现在的输出」
  是本包最坏的结果:尺会变成规则的复印件。
- 已知不过的样本写在 `../session-memory-zh-eval.test.mjs` 的 `KNOWN_GAPS` 里,
  每条带 `why` 与「修了还是报了」的决定;新增失败会让测试红,修好了也会红(提示更新 KNOWN_GAPS)。
