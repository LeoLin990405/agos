# AgOS 前端设计 V2 交付说明 (DESIGN_V2_NOTES)

## 一、完成的工作概括

本轮重构将 AgOS 前端 SPA 的视觉与交互全面推升至**旗舰级精密工程美学 (Precision Industrial Instrumentation)**，并将后端手册 55 项 RPC 与全部插件路由 1:1 映射为前端交互面。

### 1. 设计系统与材质层级 (Design System V2)
- **材质分层**：Obsidian 深色画布 (`#06080d`) ➔ 航电基底 (`#0c0f17`) ➔ 抬升卡片 (`#121723` + 1px 镜面内高光 `inset 0 1px 0 rgba(255,255,255,0.08)`)。
- **排印规范**：Geist / Geist Mono / JetBrains Mono 字体栈，全域数字挂载 `tabular-nums`。
- **共息锁相**：`useSymRespiration()` 维持全站 2400ms (25 BPM) 单一毫秒时间基准。
- **灯语纪律**：四态（等待中/处理中/已完成/未成功），`infinite` 动画严格仅属于运行态，失败红点静止，`prefers-reduced-motion` 全降级。

### 2. 后端能力 1:1 映射与页面落地
- **对话流甲板 (`ChatPage`)**：
  - 顶栏挂载主机标识 (`host.describe`)、网络状态与上下文水位。
  - 目标横幅 (`GoalBanner`): 映射 `goal.create/edit/pause/resume/complete/clear`。
  - 新建会话弹窗 (`NewSessionModal`): 映射 `session.create` + `host.pickDirectory` + `agentPreset.*`。
  - 模型切换器 (`ModelSelector`): 映射 `session.models / selectModel`。
  - 提问面板 (`QuestionPanel`): 映射 `questions/requested` (Claude 风格 `input_required` 人工决策独立态)。
  - 完整工具卡片家族：
    - Bash 终端卡（🔴🟡🟢 航电微灯与 Exit Code）✅
    - Swarm 批次卡（8 行四态 + CivStrip 投票/晋升门）✅
    - Team 编队卡 (`team_form·send·status·disband`) 🎨
    - Memory 沉淀卡 (`memory_submit` 附带图谱新节点动态生长动效) 🎨
    - Plan 计划卡 (`plan_run`) 🎨
    - Todo 看板条 (`todos`) 🎨
    - 特权审批面板 (`approvals` -> `/api/respond`) ✅

- **控制台六大功能面 (`ConsolePage`)**：
  - 📊 **概览 (Overview)**：5 大 Hero KPI 读数 + 注意力收件箱 (Priority Threads) + 满载/冷启双密度即时切换。
  - 🖥️ **机器 (Fleet / Machines)**：映射 `/api/fleet/hosts`，呈现 4 台物理刀片机架、CPU/MEM/IO 实时遥测仪表。
  - 💬 **会话 (Sessions)**：全量会话高密度审计矩阵（费用/Token/步骤/过滤）。
  - 🧬 **谱系 (Lineage)**：映射 `/api/swarm/progress` + `/api/civ/runs`，三段级联展开详情（状态/任务/最终回复 `subagent.*`）+ 历史档案标签。
  - 📋 **计划 (Plans)**：映射 `/api/cn/plans`，计划归档表 + 步骤级联展开与 4 态执行状态。
  - 🧩 **技能 (Skills)**：映射 `/api/agos/skills` + `skill.list`，14 项核心技能注册表与审计状态。

- **旗舰新页：记忆图谱 (`MemoryGraphPage`)**：
  - **手写 Canvas 力导向图**：零外部依赖、`requestAnimationFrame` 物理力仿真（弹性引力 + 库仑斥力 + 速度阻尼）。
  - **124 篇真实感记忆节点**：5 类类型颜色（User/Feedback/Project/Reference/Incident），节点大小按 `outDegree` 缩放，`dangling` 待写双链以虚线渲染。
  - **共息心跳呼吸**：最近 7 天内有更新的节点自动挂载 2400ms 共息光晕。
  - **深度交互**：Hover 一跳邻域高亮与单边淡出、点击固定右侧抽屉检视器、实时搜索过滤、缩放与仿真启停。

- **系统设置 (`SettingsPage` 📋)**：
  - 映射 `settings.*` 与 `credentials.*`，特权回环限制 (Loopback Only) 状态设计与只读凭据库。

---

## 二、质量与构建验证

- **TypeScript 类型检查**：`npm run typecheck` (`tsc --noEmit`) ➜ **0 错误，全部严格通过**。
- **Vite 生产构建**：`npm run build` (`vite build`) ➜ **732ms 编译通过**，输出高度优化的 `dist/` 产物。
- **P0 契约冒烟测试**：`npm run smoke` (`tsx scripts/smoke.ts`) ➜ **9/9 核心契约用例全部 PASS**。
- **禁改目录守则**：未修改 `src/stores/`、`src/fold/`、`src/api-client/`、`src/contract/`、`vite.config.ts`、`package.json`，未新增任何 npm 依赖。

---

## 三、已知余量与后续接线

- 所有 🎨 状态组件与页面均已按照真实后端数据契约定义 TypeScript 接口与真实感 Mock 数据。
- 后续可无缝将 🎨 组件与 Claude / OpenCLI 正在推进的真数据端点进行直连接线！

---

## 四、2026-08-21 多模态输入接线与离线自查

- 语音：`VoiceInput` 使用原生 `MediaRecorder`，把 `{ audio: <裸 base64>, mime }` POST 到 `/api/cn/asr`；成功只回填草稿，不自动发送。录音态使用 running 灯语；系统启用 `prefers-reduced-motion` 时沿用全站静态降级。
- 图片消息：CommandDeck 支持粘贴、拖拽和文件选择，最多 4 张、单张 5 MB；`sendPromptParts` 是 `src/stores/live.ts` 唯一新增导出，既有函数签名与逻辑未改。当前发送把 `[图片 ×N]` 写进 text part，确保 fold 不改动时历史回放仍有占位；本轮浏览器内同时展示缩略图。
- 交叉读图：图片缩略图可调用 `/api/cn/vision`，卡片展示 panel 的 provider/成功态/耗时/错误与 arbiter 结论，支持取消和关闭。视觉路由的紧凑响应不含各家正文，前端随后只读查询既有 `/api/cn/council-records`，按本次 `imagePath` 补齐每家最多 6000 字的台账答案；台账失败或 3 秒内未响应时安全降级为状态摘要。
- 本地预览：原图 base64 只在发送所需的附件草稿中驻留，乐观消息保存最长边 320px 的浏览器缩略图；Canvas/解码不可用时使用固定轻量占位图，绝不回退保留完整 base64。每条消息带不可见唯一标记，确保连续发送相同文案或纯图片时缩略图不串线。历史冷回放仍按约定显示 `[图片 ×N]`。
- 红线：所有开发验证均使用 fake fetch、fixture 与 fake attachment service；未调用真实 ASR、视觉、`session.prompt` 或模型。

### Stub/fixture 自查清单

- [x] 录音态：原生 MediaRecorder 状态机为 recording → transcribing，running Dot 可见且成功只触发回填；ASR 网络层使用 fake fetch。
- [x] 转写失败态：stub `/api/cn/asr` 的 HTTP/error payload，错误在输入区小字呈现。
- [x] 图片超限：fixture 覆盖第 5 张、单张超过 5 MB、非 PNG/JPEG/WebP/GIF。
- [x] 视觉失败家：stub `/api/cn/vision` 覆盖 panel 单家失败、全失败与非法响应，卡片保留错误徽章/详情。
- [x] 图片历史占位与 parts：纯函数测试断言 text + image parts、`[图片 ×N]` 与唯一回绑标记。
- [x] 并发边界：纯函数回归覆盖发送期间 ASR 回填不丢稿；实现会在发送前等待图片 intake，清空/卸载以 generation 使迟到读取失效。
- [x] 视觉正文：stub 首次返回紧凑 vision 结果、第二次返回只读台账，断言按 `imagePath` 补齐 panel 全文；台账失败回落紧凑结果。
