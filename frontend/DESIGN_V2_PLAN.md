# AgOS 前端设计 V2 实施方案 (DESIGN_V2_PLAN)

## 一、美学方向与设计内核
- **方向**：旗舰级「遥测甲板 (Telemetry Deck) + 共息 (Sym-Respiration)」——杜绝廉价感与无节制霓虹，追求极度严谨的**精密工程美学**（Precision Industrial Instrumentation）。
- **材质分层**：Obsidian 底层画布 (`#06080d`) ➔ 航电表面层 (`#0c0f17`) ➔ 抬升卡片层 (`#121723` + 1px 镜面内高光 `inset 0 1px 0 rgba(255,255,255,0.08)`) ➔ 悬浮交互层 (`#1a2233`)。
- **排印与数字**：Geist / Geist Mono / JetBrains Mono 字体栈；全域数值严格挂载 `tabular-nums`。
- **灯语纪律**：四态（等待中/处理中/已完成/未成功）；`infinite` 动画**仅**属于「处理中」；失败恒为静态红；`prefers-reduced-motion` 全降级。

## 二、Design Tokens 表 (V2 核心常数)
| Token 类别 | 常数定义 | 规范与作用 |
|---|---|---|
| 动效周期 | `--u-dur-scan: 2400ms` (25 BPM) | 全局同相位锁相心跳基准 (`useSymRespiration`) |
| 微交互时序 | `--u-dur-tick: 90ms`, `--u-dur-fast: 140ms` | 挡位感瞬变、无拖泥带水过渡 |
| 4态灯语 | 蓝 `#00a6ff`, 绿 `#10b981`, 红 `#f43f5e`, 灰 `#64748b` | 激光精准度点阵与多阶径向光晕 |
| 记忆图谱5色 | User 蓝 / Feedback 绿 / Project 紫 / Ref 橙 / Incident 红 | 知识图谱节点类型视觉语义 |
| 表面镜面光 | `box-shadow: inset 0 1px 0 rgba(255,255,255,0.08)` | 消除平面灰框，构建 Apple Pro / Linear 级材质海平面 |

## 三、逐页与功能模块映射清单

### 1. 全局导航架构 (AppRail)
- 导航扩展为四大主区：**💬 对话 (Chat)** / **📊 控制台 (Console)** / **🧬 记忆图谱 (Memory Graph)** / **⚙️ 系统设置 (Settings 📋)**。
- 谱系整合入控制台六大功能面，同时在顶层提供快捷换乘。

### 2. 对话流甲板 (ChatPage)
- **顶栏遥测**：集成主机徽章 (`host.describe`)、网络状态、上下文水位与延时。
- **目标横幅 (Goal Banner 🎨)**：挂载 `goal.create/edit/pause/resume/complete/clear` 目标状态栏。
- **会话侧栏**：接入真实 `sessionsStore` + 搜索 (`session.search`) + 新建会话流弹窗 (`session.create` + `agentPreset.*` + 目录选择 🎨)。
- **工具卡片家族**：
  - Bash 终端卡（🔴🟡🟢 航电微灯）✅
  - Swarm / Civ 批次卡（8 行四态 + CivStrip 投票/晋升门 🎨）✅
  - Team 编队卡 (`team_form·send·status·disband` 🎨)
  - Memory 沉淀卡 (`memory_submit` 附带图谱新节点长成动效 🎨)
  - Plan 计划卡 (`plan_run` 🎨) 与 Todo 看板条 (`todos` 🎨)
- **交互面板**：特权审批面板 (`approvals` ✅) + 提问面板 (`questions/requested` 人工接管独立态 🎨) + 模型下拉选择器 (`session.models` 🎨)。

### 3. 控制台六大功能面 (ConsolePage)
- **概览 (Overview)**：5 大 Hero KPI 读数 + 注意力收件箱 (Priority Threads) + 满载/冷启双密度即时切换。
- **机器 (Fleet / Machines 🎨)**：4 节点物理机架矩阵、CPU/MEM/IO 实时遥测仪表、网络连接度。
- **会话 (Sessions 📋)**：全量会话高密度审计矩阵（费用/Token/步骤/右键操作）。
- **谱系 (Lineage 🎨)**：根中枢 + Swarm/Civ 拓扑树 + 3 段级联展开详情（状态/任务/最终回复 `subagent.*`）+ 历史档案标签。
- **计划 (Plans 🎨)**：计划归档表 + 步骤级联展开与 4 态执行状态。
- **技能 (Skills 🎨)**：14 官方与审计发现技能注册表、标签检索与启用状态。

### 4. 重点新页：记忆图谱 (MemoryGraphPage 🎨)
- 纯手写 HTML5 Canvas 高性能力导向图（`requestAnimationFrame` 物理引擎，零外置依赖）。
- 120+ 真实感记忆节点（User/Feedback/Project/Reference/Incident 5 类颜色映射，大小按 `outDegree`，待写 `dangling` 边虚线渲染）。
- 最近 7 天活跃节点挂载全局 2400ms 共息呼吸心跳。
- 支持 Hover 一跳邻域高亮、点击侧栏固定抽屉、实时搜索过滤与镜头重置。

### 5. 系统设置 (SettingsPage 📋)
- 特权面 (Loopback Only) 设置预览、模型凭据管理、审计安全策略、只读降级状态设计。
