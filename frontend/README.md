# AgOS Frontend

The telemetry-deck SPA (Vite + React, TypeScript strict). Served by the `dsh-agos` plugin at `http://127.0.0.1:3091/agos/`.

## Layout

- `src/contract/` — the DSH API contract, vendored from [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) and pinned by `UPSTREAM.pin`; `npm run vendor:diff` checks pinned wire constants and freezes reviewed adapter contents; full host compatibility needs integration coverage.
- `src/stores/` — live stores over the host mux (sessions, fleet, telemetry).
- `src/fold/` — transcript folding, verified byte-identical against golden files.
- `src/components/`, `src/pages/` — the twelve surfaces; every verdict string on screen is computed from the payload it describes.
- `src/design-system/` — dark-first tokens, four-state lamps (`queued / running / done / failed`), tabular numerals for anything that counts.
- `scripts/` — replay invariants, mux frame probe, smoke.

## Commands

```bash
npm install
npm run dev        # local dev server (proxies /api to :3091)
npm run build      # dist/ consumed directly by the dsh-agos plugin
npm run verify     # host version + types + tests (365 pass / 1 skip, 2026-09-08) + build + adapter guard
```

Design notes live in `DESIGN.md`; the honesty rules it encodes (no fabricated numbers, "not collected" as a first-class state, quarantined write endpoints) are enforced by the test suite, not by convention.

## 演示模式 Demo mode（不连 dsh 宿主）

`npm run dev` 后打开 `http://127.0.0.1:3092/agos/?demo=1`（或 `VITE_AGOS_DEMO=1 npm run build`）。`?demo=0` 退出。

- `src/demo/demo-transport.ts` 只替换 `/api/*` 的 `fetch` 与 `/api/remote.mux` 的 WebSocket；冻结层（stores/ fold/ api-client/ contract/）一行未改，真链路照常跑在样例数据上。
- 样例全部可辨认：会话 id 以 `demo-` 开头、标题与发言带【示例数据】、provider 为 `demo-fixture`；底部常驻 DEMO 条；顶栏把「已连接」换成「演示数据」。
- 没有样例的端点一律回 `503 DEMO_NOT_COLLECTED`，界面照 DESIGN.md 显示「未采集」，不补数字。概览只给 `sessions.total`（= 样例会话条数）。
- 只读：任何写请求回 `403 DEMO_READ_ONLY`，不落盘。
- `src/demo/demo-fixtures.test.ts` 用冻结层的 zod schema 与 `parseMemoryGraph` 校验样例，契约漂移会直接挂测。
