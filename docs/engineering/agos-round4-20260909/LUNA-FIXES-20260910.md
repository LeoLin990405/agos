# Luna 修复说明（2026-09-10）

状态：**本地代码修复验收通过；Linux 实机/来源可重建未完成**
Owner：**Luna**
基线：`745a0a689b699d79740b5d2c29c400a2d18fef41`（第三轮修复已包含）

本页记录本轮针对第四轮独立核查所作的修复与最终验证边界。候选提交与上传事实不在
本页宣称范围内。

## R4-01 至 R4-08 状态表

| 问题 | 范围 | Owner | 当前状态 | 下一步 |
|---|---|---|---|---|
| R4-01 Linux marker 误识别 launcher | Linux | Luna | **已实施，独立复审通过** | Linux 环境仍 blocked |
| R4-02 adapter 放行缺 hash / count 证据 | Gate | Luna | **已实施，独立复审通过** | final code-gate 1263/0/5 |
| R4-03 swarm 条件 exports 解析不一致 | Swarm | Luna | **已实施，独立复审通过** | final swarm 19/19，来源未知 |
| R4-04 provenance 对照 unavailable / identical 误判 | Swarm | Luna | **已实施，独立复审通过** | 不代表来源可审计 |
| R4-05 swarm 永不结算缺 deadline | Swarm | Luna | **已实施，独立复审通过** | final 入口自检 10/10 |
| R4-06 host blocked 缺 recovery command | Host | Luna | **作者已完成，独立复审通过** | host 9 场景、unit 117 pass |
| R4-07 显式 host/browser 路径缺可执行性校验 | Host | Luna | **作者已完成，独立复审通过** | 311 个非 Markdown frontend 文件哈希未变 |
| R4-08 tracked deletion 摘要不一致 | Gate / Linux | Luna | **已实施，独立复审通过** | 删除/symlink 摘要边界已复核 |

报告结论是八项及三个相邻边界的本地代码修复验收通过；这不等于所有环境层通过。Linux
当前实测仍为 `blocked`（Darwin，无可用 Linux 运行时）；本地旧 swarm final 19/19 与入口
10/10 的模块入口 SHA-256 为 `0a912120a30728164b5d8155544468dc9ca13f70a22d3210ffd15af4af547b71`，
但来源未知、不可审计、不可独立重建。

Mutation 反证为 **23/23** 与 **15/15** 全部捕获；588 个源码清单在测试前后仅 floors
上调一项，10 项 floor 未降低且与实测 counts 相等。

## 历史口径更正

- V 的正式门记录 **1246 pass / 1 fail / 5 skip** 必须保留；controller 修复 farm EPIPE
  后的 **1247 pass / 0 fail / 5 skip** 也必须保留。后者不能改写前者为“从未失败”。
- 第三轮的 1069/5 与 1063/8 均为历史记录。两者差异包含上一轮十项代码/测试修复，
  不能归因于 swarm 配置；当时真实 swarm 覆盖也未被可靠证明。
- “ledger 写入超过 2 秒”不是已由时间戳证明的唯一根因，文档不以此作定论。

## 后续填写规则

最终证据根：`/Users/leo/Projects/agos-analysis/2026-09-10/luna-round4-fixes/verification/final/`。
Acceptance SHA-256 为 `311c0c3adde83fb9a479fa5c68f3bff19598d104970293483b4235e5cbd2cfea`，
matrix SHA-256 为 `1027af970b770d42b7b0bc86b7f92bd311e8fc840e3afd01688b39bd153aff0f`。
`allVerified=false`；不宣称全层通过、候选提交或上传。
