# DESIGN.md — 现状速记(V2,待精修)

- Tokens: src/design-system/tokens.css(深色默认 #06080d→#121723 三层;浅色 data-theme=light;四态 state-* 色族;--u-dur-* / --u-ease-*;2400ms 共息)
- 字体: Geist / Geist Mono / JetBrains Mono(CDN),数字 tabular-nums
- 布局: layout.css(app-rail 左 64px 图标栏 / 各页自管);deck.css(卡片/终端/消息流)
- 组件: src/components/ui(Dot/Chip/Badge/Button/KpiCard/TerminalCard/DiffCard/SegmentedControl)+ chat/console/lineage 族
- 已知病(用户两轮"太丑"的解剖): 层级靠边框不靠明暗,表面海拔感弱;主字号偏小而留白偏散;accent 蓝到处点缀反而没有焦点;图标是 emoji,精密感掉档;topbar 遥测 pill 是装饰 mock
