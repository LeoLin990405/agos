# AgOS 前端设计 V2 Brief(给 Gemini,2026-08-20 深夜)

Leo 对 V1 的裁定:**方向对,但科技感不够**。本轮重设计目标:把「遥测甲板」推到真正的旗舰级科技风,并把**后端全部能力 1:1 映射成前端面**——不再只有三页,而是一个完整的 Agent OS。

## 你的工作对象

本仓已是 **Vite + React 18 + TS 的活应用**(不再是静态原型):`npm run dev`(:3092,代理直连本机 dsh)或访问 `http://127.0.0.1:3091/agos/`(生产构建,dsh 直接 serve)。数据层已接真后端(`src/stores/live.ts`:会话/对话 fold/遥测;**stores 与 fold 禁改**)。

**改动范围**:`src/design-system/**`(tokens/css 全权重写)、`src/components/**`、`src/pages/**`(可新增页面与路由)、`src/App.tsx`(路由表)。**禁改**:`src/stores/`、`src/fold/`、`src/api-client/`、`src/contract/`、`vite.config.ts`、`package.json`(不加依赖!)。每步 `npm run typecheck` 必须 0 错,最后 `npm run build` 必须过。

## 参考对象(四个 App,各取其长)

此前已对本机真实 App 做过逆向调研(细节见 `docs/design/raw-directions.md` 与下表),你综合它们再往上打一档:

| App | 拿什么 |
|---|---|
| **Codex.app** | Subagents 面板的三段递进详情(状态/委派任务/最终回复);四态词表(等待中/处理中/已完成/未成功);priorityThreads 注意力视图「没有需要关注的任务」的克制 |
| **Manus** | 队列一等公民(排队位次可见);Live/Replay 同轴;任务接管闸;工具动作全部配人话描述 |
| **Claude App** | input_required 独立态(等人>等机器);会话即任务卡;安静的层级——深色不是黑底加霓虹,是**材质分层**(表面海拔/毛玻璃/精细边框) |
| **Kimi** | 中文排印的舒展(行高/字距/标点悬挂);长文阅读态的呼吸感 |

**科技风的定义**(避免俗套):不是加更多霓虹光晕——是**精密感**。等宽数据、微网格、毛玻璃层、扫描线只在关键时刻出现一次、共息心跳全站锁相(已有 `use-sym-respiration.ts`,保留并用足)、数字滚动、状态灯语严格。参考 Vercel/Linear/Arc 的克制 + 航电仪表的密度。灯语纪律不变:**infinite 动画只挂运行态,失败红点静止,reduced-motion 全降级**。

## 后端能力 → 前端映射总表(Leo 点名要的「Node」;每条都要有归宿)

标注:✅=已接线(重设计时保留功能只换皮)/🎨=本轮设计+静态假数据实现(接线后续)/📋=本轮只在导航里占位(disabled 态也要设计)

### 宿主 RPC 面(55 方法,契约在 src/contract/api/)
| 后端 | 前端面 | 状态 |
|---|---|---|
| session.list / history / prompt | 对话页:会话列表+对话流+输入 | ✅ |
| session.create + host.pickDirectory/listDirectory | **新建会话流**(选目录+预设) | 🎨 |
| session.cancel | 对话页:运行中的「中止」按钮 | 🎨 |
| session.search | 会话搜索(现在的搜索框接真 RPC) | 🎨 |
| session.rename / fork / updateQueue / attachment | 会话行右键菜单 + 队列编辑 + 图片粘贴 | 📋 |
| session.models / selectModel + llm.providers/models | **模型选择器**(输入区下拉) | 🎨 |
| subagent.list / history / prompt / interrupt | 谱系页:子代理行点开=完整子会话详情 | 🎨 |
| approvals(mux → /api/respond) | 审批面板(已接 respond) | ✅ |
| questions(question/requested) | 提问面板(等人独立态,Claude 风) | 🎨 |
| goal.create/edit/pause/resume/complete/clear | **目标横幅**(对话页顶部,有 goal 时出现) | 🎨 |
| workspace.*(7 方法) | 侧栏工作区分组 | 📋 |
| agentPreset.*(6 方法) | 新建会话流里的预设选择 | 🎨 |
| settings.* / credentials.* | **设置页**(loopback 特权面) | 📋 |
| skill.list | 技能页(与 /api/agos/skills 合并呈现) | 🎨 |
| host.describe | 顶栏主机徽章 | 🎨 |

### 插件路由(本机已在跑,curl 即得真数据)
| 路由 | 前端面 | 状态 |
|---|---|---|
| /api/agos/overview | 控制台概览 KPI | ✅ |
| /api/swarm/progress(?since)| 谱系页批次树 + 卡片 | ✅ |
| /api/swarm/history?day= | 谱系页「历史」标签(跨重启档案) | 🎨 |
| /api/swarm/result?agentId= | 谱系行详情的「最终回复」 | 🎨 |
| /api/swarm/interrupt | 谱系行「停止」按钮 | 🎨 |
| /api/agos/skills | **技能页**(审计发现+筛选,V1 原型有设计,搬进 SPA) | 🎨 |
| /api/fleet/hosts (+trace/ws) | **机器页**(机架阵列真值) | 🎨 |
| /api/cn/plans | **计划页**(档案+展开步骤) | 🎨 |
| /api/civ/runs + regimes | 谱系页 civ 分组(政体徽章/投票/晋升门) | 🎨 |
| /api/cn/council-records | civ 议事记录抽屉 | 📋 |
| /api/trace/sessions | 会话页表格增强(费用/steps) | 📋 |
| **/api/memory/graph**(Codex 在建,契约见下) | **记忆图谱页** | 🎨 |

### 工具卡片家族(对话流内渲染)
bash 终端卡 ✅ / swarm·civ·fleet 批次卡 ✅(补 civStrip 投票/晋升门显示 🎨)/ 通用工具行 ✅ / **team_form·send·status·disband 编队卡** 🎨 / **memory_submit 记忆沉淀卡** 🎨(小图谱节点动画:一颗新节点长进图里)/ plan_run 计划卡 🎨 / todo/write 看板条 🎨(fold 已产出 todos)

## 重点新页:记忆图谱(Graph Engineering)

Leo 点名要**我们记忆库的 Graph Engineering 感觉**:120+ 篇记忆(user/feedback/project/reference/incident 五类)靠 `[[wikilink]]` 互链成图。

- 数据契约(Codex 实现中,先用静态 mock JSON 顶上,形状以此为准):`GET /api/memory/graph` → `{ nodes: [{id,type,description,bytes,mtime,outDegree}], edges: [{from,to,dangling}], counts }`
- 设计要求:**Canvas 力导向图**(手写 requestAnimationFrame 力模拟,禁引依赖;节点数 ~150,性能无压力);节点按 type 五色灯语、大小按 outDegree;dangling 边虚线(这是记忆库真实的待写钩子,不是错误);hover=高亮一跳邻域+侧栏详情(description/类型/度数);点击=侧栏固定;搜索定位节点;深浅双主题。
- 这页是「科技风」的主秀场:星图感、共息呼吸只给「最近 7 天有更新」的节点。

## 导航重构

三页 rail 扩成完整 OS 导航(参考 V1 原型 02 的 console-nav):**对话 / 控制台(概览·机器·会话·谱系·计划·技能)/ 记忆图谱 / 设置📋**。谱系并入控制台或独立由你定,给出理由。

## 交付与自查

1. 分两步提交:先 `DESIGN_V2_PLAN.md`(方向陈述+token 表+逐页处理清单,≤150 行)落仓,**不等审批直接继续**实现——plan 是给 Claude 审查时对账用的;
2. 实现全部 ✅ 换皮 + 🎨 页面/组件(🎨 未接线的用**真实感 mock 数据**,形状对齐上表契约;📋 出现在导航但 disabled 态也要设计);
3. 自查:`npm run typecheck` 0 错、`npm run build` 过、深浅双主题逐页可读、空态有设计、灯语纪律 grep 自查(infinite 只在 is-running/is-run 下);
4. **禁改清单再读一遍**;不加任何 npm 依赖;完成后写 `DESIGN_V2_NOTES.md`(做了什么/每页截图说明可省/已知余量)。

完成后 Leo 汇总,Claude 用 OpenCLI 做全站网页回归测试,全绿进下一阶段(接线 🎨 页的真数据)。
