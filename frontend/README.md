# AgOS Frontend

The telemetry-deck SPA (Vite + React, TypeScript strict). Served by the `dsh-agos` plugin at `http://127.0.0.1:3091/agos/`.

## Layout

- `src/contract/` — the DSH API contract, vendored from [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) and pinned by `UPSTREAM.pin`; `npm run vendor:diff` fails on any drift.
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
npm run verify     # typecheck + 286 tests + contract zero-drift
```

Design notes live in `DESIGN.md`; the honesty rules it encodes (no fabricated numbers, "not collected" as a first-class state, quarantined write endpoints) are enforced by the test suite, not by convention.
