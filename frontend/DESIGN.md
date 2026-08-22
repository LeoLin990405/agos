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
- 技能工作室: 控制台第三档。只新建到 `~/.dsh/skills`，已存在拒绝覆盖，不写 `~/.claude/skills`。插件 stub 只写 `~/.dsh/agos/plugin-stubs`，未装进 profile。词面评测/短名单，不编模型触发率。自进化=词面 bench + Beta-Bernoulli 后验（FuguNano allocate）；`skill()` 调用不是胜负。小模型只提案短名单且失败回退，默认未采集；不写路由 decide。本跳 catalog 裁剪默认关闭。审计台不动。
- 模型组装: 路由面可 confirm 后出 planner/implementer/reviewer 提案。StepFun 分类 + 台账后验。不换本跳会话模型，不 POST decide。只报告。空态/概览/记忆检查器可跳进工作室与组装。待回填决策可人工记成功/失败，需确认。
- 冻结层: `stores/` `fold/` `api-client/` `contract/` `vite.config.ts` `package.json`

## 结构签名

Claude 材质海拔 + Cursor 会话工作面。仪表带是运行带 + 诚实空位，不是五格同宽英雄数。
