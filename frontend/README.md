# AgOS 前端(agos-frontend)

dsh(deepseek-harness)的**自有 SPA 前端**。不 fork 上游前端;唯一上游耦合是一层「对齐膜」:
vendored 契约 + vendored fold/markdown(P1 起)。依据:TASK-2026-08-20-003。

## 现状(P0 完成)

- `src/contract/api/` —— vendored 自上游 `packages/host/apiproxy/src/api/`(zod 契约,
  浏览器可 import,零 Node 依赖)。pin 见 `UPSTREAM.pin`。
- `src/contract/shims/` —— 契约层引用的 10 个外部包的**纯类型** shim(全部 import type,
  运行时擦除;P1 vendor fold 时按需换成真实定义)。
- `src/api-client/` —— 自写客户端:unary `call(method, payload)`(POST `/api/<method>`,
  信封 + rpcId 回显校验 + 二级 zod value 解析)、`mux()/host()` 两条事件流、
  `respond()`(审批回包)、`watchStream()` 断线重连助手(退避重开 + onReconnect 全量重拉)。
- `scripts/smoke.ts` —— P0 冒烟:`npm run smoke`。

## 协议要点(实证,2026-08-20 @ 47f9438 源码 + rc 部署实测)

- 两条事件流**有两副物理面孔**(迁移期并存):pin 克隆的 fetch carrier 面是流式 fetch 上的
  SSE 帧(`\n\n` 分帧);**当前 rc 部署面是 WebSocket**(GET 回 `426 upgrade: websocket`)。
  本仓 api-client 默认 auto:有 WebSocket 用 WS,否则 SSE——两面的信封与 payload 完全一致。
- 帧 = ServerRequest 信封(JSON 文本);审批走 `approval/requested`(可答)→ `POST /api/respond` → `approval/resolved`。
- 无协议版本号:升级 = `npm run vendor:diff` 对漂移 → 修类型错 → `npm run smoke`。
- 无认证,同源栅栏:`sec-fetch-site: cross-site` 直接拒 → 前端必须同源部署
  (部署缝:profile `cordis.patch.yml` 覆盖 `frontend-static` 的 `distIndex` 指向我们的 dist)。
- 断线重连 = 重开两条流 + 全量重拉 `session.history`(`since` 未实现)。

## 路线图

- **P0 ✅ 契约客户端**(本目录现状)
- **P1 会话核心**:vendor 上游 shared fold + history 全量重建 + stores,单测驱动(语料:`~/.dsh/sessions-trash-20260820` 392 条真实历史)
- **P2 聊天 UI**:遥测甲板设计系统(TASK-002 产物);流式 markdown 用 streamdown(Vercel,活跃)
  或 vendor 上游 incremental;工具卡族 + swarm 卡迁入
- **P3 AgOS 原生化**:控制台六页迁为主路由
- **P4 设置最小面 + Electron/Tauri 壳** `loadURL` 本机 dsh;patch.yml 切 distIndex,旧桌面退役
