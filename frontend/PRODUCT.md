# PRODUCT.md — AgOS 前端

register: product

## Product Purpose
AgOS 是 Leo 的个人 Agent 操作系统前端:统一驾驶 dsh 后端(会话对话、swarm/civ/fleet 批量子代理、团队编队、计划、技能、Fleet Memory 记忆图谱)。单用户、本机部署、日用工具。

## Users
一个用户:Leo,资深 AI 工程师/舰队指挥。每天长时间盯着它调度几十个子代理。深夜使用居多,27 寸显示器,昏暗房间。要求一眼读出「谁在跑、谁挂了、谁在等我」。

## Brand & Tone
「遥测甲板 + 共息」:航电仪表的精密感,不是霓虹赛博。等宽数据、灯语四态(等待中/处理中/已完成/未成功)、全站 2400ms 共息锁相(运行态同相位呼吸)、空闲绝对静止。中文为主。

## Anti-references(用户已两次否决的方向)
- 平淡的"工程师 wireframe"(V1 病:空旷、无锚点、色彩怯场)
- 加更多霓虹光晕/发光边框的"赛博朋克"堆料(俗套科技风)
- SaaS 模板感:同尺寸卡片阵列、hero-metric 大数字模板、渐变文字

## Strategic principles
- 密度即尊重:这是指挥台,不是营销页
- 灯语纪律不可破:infinite 动画只属于运行态;失败红点静止;reduced-motion 全降级
- 数据层(src/stores、src/fold、src/api-client、src/contract)与 vite.config/package.json 禁改;不加 npm 依赖
