# TASK-2026-08-20-003: DSH 前端完全自有化(AgOS 前端)总体方案
Status: PENDING(待 Leo 拍板后开工)
Priority: P0
Created: 2026-08-20 23:55
依据: 4 路源码侦察实证(原始报告见 scratchpad ws6jc09q0.output;上游克隆 ~/Projects/deepseek-harness @ 47f9438,0.1.0-rc.5)

## 决定

**全新自有 SPA,不 fork 上游前端。** 以后上游升级只对齐一层膜:`packages/host/apiproxy/src/api/`(zod 契约,浏览器可 import)+ `packages/api` Typert Remote。前端代码 100% 我们写、我们的设计语言(遥测甲板+共息)、我们的节奏。

三点理由(全部实证):
1. fork 要永久背 18k 行平台层(cordis client/slot/模块加载/tsdown 双构建)+ 工具链——这层与 host 咬合最深,恰是「不追上游前端」时最不该背的
2. 我们 8 个插件的 client 半区**全是自己写的**,迁成自有前端的一等组件即可,不需要为它们复刻插件加载契约(那份最小契约 = 10 个 seed 模块 + cordis DI + 槽位注册表,实质就是整个平台层)
3. MIT 许可:上游前端里真正难写的两块——**事件折叠 fold**(events→对话面)和 **markdown 增量渲染**——可以直接 vendor 进来变成我们的代码,从此只由我们维护

## 侦察核心事实(细节见原始报告)

- **协议面**:`POST /api/<method>`(RpcMethodMap ~45 方法:session.create/prompt/cancel/history/fork、subagent.*、workspace/settings/credentials/llm)+ `/api/events.mux`(会话事件聚合,含 ToolEventView 渲染意图 + queue/jobs/projection 快照帧)+ `/api/events.host`。审批:mux `approval/requested` → `POST /api/respond` → `approval/resolved`。
- **无协议版本**(pre-release,client+host 同船):自有前端必须 **pin 上游 commit**,升级仪式 = diff 契约目录 + 修类型错 + 冒烟。
- **无认证**,只有 loopback/trustedHosts + 同源栅栏(`sec-fetch-site: cross-site` 直接拒)→ 自有前端必须**同源部署**。
- **断线重连** = 重开两条 WS + 全量重拉 `session.history`(`since` 游标未实现)——fold 必须支持从 history 全量重建。
- **部署缝零 fork**:profile 的 `cordis.patch.yml` 覆盖 `frontend-static` 的 `distIndex` → dsh 进程原样 serve 我们的 dist(`__DSH_BOOT__` 注入照常打进 index.html,忽略即可)。
- **桌面**:本机 asar 桌面 App 是树外构建,不受影响也不升级;终局是自有壳(Electron `loadURL` → 本机 dsh web,壳层零上游 churn)。

## 架构

```
┌─ AgOS 前端(自有仓,Vite + React 18 + TS)──────────┐
│  遥测甲板设计系统(ui-kit token/原语,TASK-002 产物) │
│  路由:对话 / 控制台(概览·机器·会话·谱系·计划·技能)  │
│  组件:聊天流+工具卡(swarm 卡在此为一等组件)+审批+输入 │
│  数据层:fold(vendored)+ stores                      │
│  api-client:unary fetch + mux/host WS + zod 校验      │
├─ 对齐膜(唯一上游耦合)────────────────────────┤
│  vendored: apiproxy/api/* 契约 + api/remotes 允许表     │
│  vendored: shared fold + markdown incremental(MIT)     │
└─ dsh 后端(npm 官方包,照常升级)─────────────────┘
   serve: frontend-static distIndex → 我们的 dist(patch.yml)
```

**8 个插件的去向**:server 半区(index.js,/api/swarm/* /api/agos/* /api/fleet/* …)**原样不动**——它们本来就是后端路由,继续随 dsh 加载。client 半区迁为前端一等组件:swarm 卡→工具卡组件;AgOS 控制台→应用主路由(不再是 overlay);fleet 机架/trace/cn-capabilities→控制台页面。ui-kit 的 CSS 原语直接搬入设计系统。第三方插件的 client UI(如 diff-review)不再支持——代价已知且可接受(rc.8 web 上本就禁了)。

## 分阶段(每阶段可用、可停)

**P0 契约客户端(1-2 天)**:新仓 `agos-frontend`;vendor `apiproxy/src/api/*`;写 api-client(fetch + 2 WS + zod);对本机 :3091 冒烟:list/create/prompt/流式收帧/cancel/respond 全通。⚠️ 冒烟要发真消息,用最便宜模型、一条即可。
**P1 会话核心(2-3 天)**:vendor shared fold(上游 client 内,侦察定位后原样搬)+ history 全量重建 + 断线重连;stores(sessions/conversation/jobs 镜像);无 UI,单测驱动。
**P2 聊天 UI(1-2 周,大头)**:遥测甲板设计系统落地;消息列表/流式 markdown(vendor incremental 或 streamdown)/工具卡族(GenericToolCard + bash/file 特化 + **swarm 卡迁入**)/审批面板/输入框(先做基础:文本+图片+队列,inline 建议后补)/侧栏会话列表。
**P3 AgOS 原生化(3-5 天)**:v3-v7 控制台六页从 overlay 迁为主路由;fleet/civ/plans/skills 页;共息动效全局锁相在单一 App 里反而更容易。
**P4 设置最小面 + 桌面壳(3-5 天)**:模型/凭据/审批策略三页(特权方法钉死 loopback,正好本机);Electron(或 Tauri)壳 `loadURL` 本机 dsh;patch.yml 切 distIndex,正式替换 web 入口。旧桌面 App 退役。

**升级仪式(以后每次 dsh 升级)**:`git -C ~/Projects/deepseek-harness pull` → `diff packages/host/apiproxy/src/api packages/api/remotes` 对 vendored 副本 → 类型错就修 → P0 冒烟脚本跑一遍 → 完。前端一行不用看。

## 风险与对策

| 风险 | 对策 |
|---|---|
| fold 复杂度被低估(事件词汇多) | vendor 而非重写;P1 用真实历史会话(trash 里 392 条是现成语料!)做回放测试 |
| 协议 pre-release 期漂移 | pin commit + 契约 diff 仪式;apiproxy→Typert gateway 迁移进行中,membrane 同时 vendor 两面 |
| P2 体量失控 | 严格按「先能用后好看」切:纯文本对话可用 → 工具卡 → 审批 → 输入增强;设计系统已定稿(TASK-002),不在实现期做设计 |
| 特权面(settings/credentials)loopback-only | 本机部署无影响;远程访问场景只读降级 |
| 桌面旧 App 与新前端并存期混乱 | 并存期短:P4 前旧桌面照常用;P4 切换后退役 |

## 分工(fanout 按 v5 协作矩阵)

Claude=planner/审查/契约与 fold vendor(最难两块自己拿);P2 组件族按卡片粒度派 codex/kimi/glm;每合并过 reviewer;TASK 文件逐阶段建。

## 与 TASK-002 关系

TASK-002(遥测甲板+共息,Kimi)照常执行——它的产物(token 表/原语 CSS/动效编排)就是本方案 P2 的设计系统输入,现有插件 UI 立刻变好看,迁移时原样带走。

## 执行日志

- 2026-08-20 23:55 Claude:4 路侦察完成,方案落盘,待拍板。
- 2026-08-20 晚 Kimi 交付 P0(仓在 ~/Documents/kimi/workspace/agos-frontend,⚠️不是方案里的 ~/Projects,迁移待定),Claude 审查**通过**:
  - 交付:vendored 契约 20 模块(`vendor:diff` 实跑**零漂移** @ 47f9438)+ 10 个纯类型 shim(tsconfig paths 映射,运行时擦除——verbatim vendor 的正解)+ 自写 api-client 356 行 + 冒烟 + UPSTREAM.pin + 升级仪式脚本。依赖面:运行时仅 zod。
  - **超预期发现**:事件流双物理面——pin 源码是流式 fetch 上的 SSE 帧,rc 部署实测是 WebSocket(GET 回 426);客户端做了 auto 双面,两面信封一致。这填了侦察报告里「apiproxy→gateway 迁移期」的实操缺口。
  - Claude 独立验证(零模型):tsc --noEmit 0 错;mapped type 强制 55 方法 schema 表全覆盖;只读探针经其 client 实测 session.list(4)/mux subscribed/host onOpen/history(18 事件) 全 PASS。Kimi 自跑全链冒烟 9/9(含一条真消息——任务书授权,但用了默认模型而非最便宜,记一笔)。
  - **审查修 1 处**(NEEDS FIX→直接改):onFrame tap 注释承诺「抛错被隔离绝不断流」但代码未包 try/catch,SSE/WS 两处补隔离,tsc 复验过,已 commit。
  - P1 待办注记:watchStream 的 onReconnect 在重开流**之前**触发,重拉 history 与流重开之间有事件空窗——P1 stores 接手重连时改为「先开流缓冲、后拉 history」。冒烟在 kimi workspace 留了 2 个测试会话(projcache 有其条目),下次清库顺手处理。
