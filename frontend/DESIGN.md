# DESIGN.md — 现状速记（2026-08-22 壳 + 可视化重设）

- Tokens: `src/design-system/tokens.css` — 深色底 `#0c0c0e`、layer-1 `#1a1a1f`；浅色 `data-theme=light`；四态 `state-*`；`--u-dur-*` / `--u-scan: 2400ms` / `--u-phase`
- 字体: 正文系统栈；数据/仪表 Geist Mono / JetBrains；数字 tabular-nums
- 布局: `layout.css` 左轨 56px 平面标；对话三栏（会话 / transcript / 贴底作曲）；控制台文字次轨 + `surfaces.css`
- 组件: `src/components/ui`（Dot/Chip/Badge/Button/…）+ chat / console / lineage / graph
- 动效: 进入 `translateY(6px)+opacity`；infinite 只挂 running 且锁共息；失败静止；扫描线已删；星图空闲停 rAF，听 `prefers-reduced-motion`
- 可视化语法 `viz.css`：轨用 `scaleX(--u-p)`；编队/谱系按真实行分段；轨迹共用本页最长尺度；机架条只映射 inflight/maxConcurrency
- 灯语: queued / running / done / failed。缺字段写「未采集」，不为好看编 KPI
- 019 锚点文案冻结（路由档位 / 只报告 / 使用率分母已采集 / 读图台账已采集 / 接入该会话 / 星图已采集 / 补链对照已采集 / 可接入）
- 记忆: 左轨同一工作台。左栏情节/技能；中栏语义星图；右栏检查器；时间层=supersedes/validUntil。技能目录走 `/api/agos/skills`，审计仍在控制台。电脑台只留精简入口。检索同时滤情节正文和技能目录。不对不上的 slug 连线。缺字段写「未采集」
- 技能工作室: 控制台第三档。只新建到 `~/.dsh/skills`，已存在拒绝覆盖，不写 `~/.claude/skills`。插件 stub 只写 `~/.dsh/agos/plugin-stubs`，未装进 profile。词面评测/短名单，不编模型触发率。自进化=词面 bench + Beta-Bernoulli 后验（FuguNano allocate）；`skill()` 调用不是胜负。小模型只提案短名单且失败回退，默认未采集；不写路由 decide。本跳 catalog 裁剪默认开，失败回退全量。审计台不动。分配/密门/prompt 见仓库 `docs/AGENT.md`。
- 模型组装: 路由面可 confirm 后出 planner/implementer/reviewer 提案。StepFun 分类 + 台账后验。不换本跳会话模型，不 POST decide。只报告。空态/概览/记忆检查器可跳进工作室与组装。待回填决策可人工记成功/失败，需确认。三角色试跑需再次 confirm：只出文本，不改仓库，不记胜负，不换本跳会话。**「派活」一词只指电脑台的 swarm 子代理批次**，组装侧一律叫「试跑」（2026-08-23）。前端是校验方不是断言方：dispatched / sessionSwitched / outcome 与冻结文案不符或缺席 → 不解析、屏上 alert 列违约点；「尚未试跑 / 已有试跑记录」由同屏 assemble+dispatch.ref 算出，不是常量。写端点只在 `routes-assemble.ts`（运行时锁：替换 fetch 记录真实 URL；仓级锁：TypeScript 扫描器查 src/** 字面量，routes/decide 零出现、写路径只许出现在该文件）；GET 走 useResource 读 `/api/agos/routes`。前端的试跑请求总是带 `ref`（asm-…，不合形不发）；后端收到 `ref` 且不等于台账最新提案即 409 `ASSEMBLE_MISMATCH`（不带 `ref` 的 curl 仍跑最新一条）。组装/试跑段落的全部时态句与空态门由 `deriveAssembleView()` 算出并有七个场景单测；`routes-assemble.runtime.test.ts` 用插件真源函数造三种信封验前端解析。
- 冻结层: `stores/` `fold/` `api-client/` `contract/` `vite.config.ts` `package.json`

## 结构签名

Claude 材质海拔 + Cursor 会话工作面。仪表带是运行带 + 诚实空位，不是五格同宽英雄数。
