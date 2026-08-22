# DESIGN.md — 现状速记(V4:DeepSeek 原生融合)

- Tokens: src/design-system/tokens.css(深色默认 #06080d→#121723 三层;浅色 data-theme=light;四态 state-* 色族;--u-dur-* / --u-ease-*;2400ms 共息)
- 字体: Geist / Geist Mono / JetBrains Mono(CDN),数字 tabular-nums
- 布局: layout.css(app-rail 左 64px 图标栏 / 各页自管);deck.css(卡片/终端/消息流)
- 组件: src/components/ui(Dot/Chip/Badge/Button/TerminalCard/SegmentedControl)+ chat/console/lineage 族
- 已知病(用户两轮"太丑"的解剖): 层级靠边框不靠明暗,表面海拔感弱;主字号偏小而留白偏散;accent 蓝到处点缀反而没有焦点;图标是 emoji,精密感掉档;topbar 遥测 pill 是装饰 mock

## V4 融合基线(2026-08-20 深夜,权威来源=上游 packages/client/ui-theme/src/styles/design-platform.css)
- 深色面:neutral-bluish 950(21,21,23)→875→850→800;浅色面:00 白 + bluish 灰阶
- accent:deepseek-400(103,158,254)深 / deepseek-500(65,118,230)浅;done=green-500;failed=red-400;warn=amber-500
- 正文字体回归系统栈(原生手感);数据/仪表保留 Geist Mono/JetBrains(我们的仪表 DNA)
- 结构签名保留:仪表带/灯语四态/共息锁相/发丝边框明暗海拔
