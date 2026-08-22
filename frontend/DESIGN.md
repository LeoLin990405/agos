# DESIGN.md — 现状速记（2026-08-22 壳 + 可视化重设）

- Tokens: `src/design-system/tokens.css` — 深色底 `#0c0c0e`、layer-1 `#1a1a1f`；浅色 `data-theme=light`；四态 `state-*`；`--u-dur-*` / `--u-scan: 2400ms` / `--u-phase`
- 字体: 正文系统栈；数据/仪表 Geist Mono / JetBrains；数字 tabular-nums
- 布局: `layout.css` 左轨 56px 平面标；对话三栏（会话 / transcript / 贴底作曲）；控制台文字次轨 + `surfaces.css`
- 组件: `src/components/ui`（Dot/Chip/Badge/Button/…）+ chat / console / lineage / graph
- 动效: 进入 `translateY(6px)+opacity`；infinite 只挂 running 且锁共息；失败静止；扫描线已删；星图空闲停 rAF，听 `prefers-reduced-motion`
- 可视化语法 `viz.css`：轨用 `scaleX(--u-p)`；编队/谱系按真实行分段；轨迹共用本页最长尺度；机架条只映射 inflight/maxConcurrency
- 灯语: queued / running / done / failed。缺字段写「未采集」，不为好看编 KPI
- 019 锚点文案冻结（路由档位 / 只报告 / 使用率分母已采集 / 读图台账已采集 / 接入该会话 / 星图已采集 / 补链对照已采集 / 可接入）
- 冻结层: `stores/` `fold/` `api-client/` `contract/` `vite.config.ts` `package.json`

## 结构签名

Claude 材质海拔 + Cursor 会话工作面。仪表带是运行带 + 诚实空位，不是五格同宽英雄数。
