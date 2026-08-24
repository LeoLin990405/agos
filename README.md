<div align="center">

[![English](https://img.shields.io/badge/Language-English-2ea44f?style=for-the-badge)](README.md) &nbsp; [![中文](https://img.shields.io/badge/语言-中文-555555?style=for-the-badge)](README.zh-CN.md)

</div>

<p align="center">
  <img src="./docs/media/agos-banner.svg" alt="AgOS Banner" width="100%" />
</p>

# AgOS — An Honesty-First Agent Operating System Deck on DeepSeek Harness

### One telemetry deck, five host plugins, and a hard rule: the screen never says anything the data cannot prove.

<p align="center">
  <img src="https://img.shields.io/badge/Surfaces-12-gold?style=for-the-badge" />
  <img src="https://img.shields.io/badge/Plugins-5-crimson?style=for-the-badge" />
  <img src="https://img.shields.io/badge/HTTP%20Routes-41-blue?style=for-the-badge" />
  <img src="https://img.shields.io/badge/Unit%20Tests-583-purple?style=for-the-badge" />
  <img src="https://img.shields.io/badge/Browser%20Regression-41%20steps-blueviolet?style=for-the-badge" />
  <img src="https://img.shields.io/badge/License-MIT-yellowgreen?style=for-the-badge" />
</p>

> **A position**: most agent dashboards are optimistic fiction — green badges with no probe behind them, leaderboards built on three samples, "97% healthy" strings typed by hand. AgOS takes the opposite bet: an agent operating system becomes *trustworthy* exactly when its UI is forbidden to decorate. Every number on screen is derived from a ledger on disk; every missing field renders as **“not collected”** instead of a made-up zero; every model-driven suggestion is recorded *before* it is trusted, shadowed *before* it is wired in.

---

## Abstract

**AgOS** is a single-user Agent OS layer for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) runtime. It replaces the stock web UI with a full **telemetry deck** — chat with multimodal input, sub-agent lineage, machine fleet, model routing, skills, and a memory workbench — backed by five DSH plugins that expose everything as auditable JSONL ledgers and typed HTTP routes.

The project explores one question end to end: **what does an agent cockpit look like if fabrication is a build error?** The answer shipped here includes repo-wide static locks that fail CI when a screen string is not derived from on-screen data, a *shadow mode* for model-driven routing that records decisions without letting them drive anything, and a labeled-corpus “ruler” that must be re-passed before any memory-extraction heuristic is allowed to change.

---

## 1. Surfaces

The deck runs at `http://127.0.0.1:3091/agos/` and maps the entire backend 1:1 — no page exists without a real data source behind it.

| Surface | What it shows | Backing |
|---|---|---|
| **Chat** | multimodal transcript (text · image · voice) with approval panels, permission-verdict annotations, session trash, per-segment voice provenance | host mux + `dsh-agos` |
| **Overview** | attention inbox merged from four ledgers (lineage failures, pending route outcomes, skill drift, flagged reviews) with per-source `ready / stale / absent` states | `/api/agos/overview` + 3 ledgers |
| **Machines & Racks** | homelab fleet: reachability, wake-on-LAN, in-flight load, batch dispatch with a cost-confirmation step | `dsh-fleet` |
| **Route Decisions** | every model-routing decision as a ledger row: pick, confidence, reason, source, outcome backfill; shadow rows visibly marked *“suggestion only — drove nothing”* | `dsh-agos-router` |
| **Outcome Coverage** | five heterogeneous ledgers normalized into one seven-field result table — deliberately **without** merging their semantics | `outcomes.js` deriver |
| **Sessions / Lineage / Trace / Plans** | live session matrix, sub-agent genealogy, timeline, plan archive | host RPC + ledgers |
| **Skills** | registry audit (model-facing vs console-only roots, content-drift detection) + a studio that only ever *proposes* | `dsh-agos` skills routes |
| **Vision Council** | multi-model image-reading panel with an arbiter that flags suspected fabrication per panelist | `cn-capabilities` |
| **Memory Workbench** | episodic / semantic / skill memory as a wikilink graph with an inspector | `dsh-civ` memory routes |

## 2. The Honesty Contract

These are not style guidelines — they are enforced by tests that fail the build:

1. **On-screen claims must be computed from on-screen data.** Sentences about a dataset are functions of the payload, never string constants. A repo-wide TypeScript AST scanner rejects hard-coded verdict copy.
2. **Absent ≠ zero ≠ false.** Every nullable field has three rendered states; “not collected” is a first-class UI state with its own copy.
3. **Write endpoints are quarantined.** All mutating `fetch` calls live in one file, checked by an AST lock (allow-listed literal URLs, no aliasing, no concatenation). The model-routing `decide` endpoint is *unreachable from the UI by construction* — the string literal itself is banned repo-wide.
4. **Suggestions are recorded, not obeyed.** The LLM route selector runs in **shadow mode**: one call per dispatch review, written to the ledger with the user's actual choice alongside — agreement is measured, never assumed. Outcome backfill only happens when the suggested machine actually ran the batch; a batch that ran elsewhere never scores the suggestion.
5. **Heuristics carry a ruler.** The session-memory extractor ships with a labeled corpus, per-sample pass baselines, and an `acceptEdit` gate: any previously-passing sample that regresses turns the suite red — improvements cannot offset regressions, and accepting a new baseline is an explicit, named act.
6. **Security gates are tested as gates.** The media route sniffs magic bytes for content-addressed files and treats caller-supplied MIME as an *expectation to verify*, with dedicated unit tests for traversal, symlinks, double extensions, and forged types.

## 3. Architecture

```mermaid
flowchart LR
  subgraph Browser
    SPA["frontend/ · Vite + React SPA<br/>(served at /agos/)"]
  end
  subgraph DSH host process
    AGOS["dsh-agos<br/>console · skills · session memory · SPA server"]
    ROUTER["dsh-agos-router<br/>selector · assemble · shadow · outcome ledger"]
    CN["cn-capabilities<br/>vision council · ASR · media gate · usage"]
    FLEET["dsh-fleet<br/>hosts · dispatch · wake · batches"]
    MCP["dsh-mcp-bridge<br/>agos_* MCP tools"]
  end
  subgraph Disk
    LEDGERS[("JSONL ledgers<br/>route-outcome · runs · council · plans · judge")]
  end
  SPA -->|typed HTTP + mux frames| AGOS & ROUTER & CN & FLEET
  ROUTER --> LEDGERS
  FLEET --> LEDGERS
  CN --> LEDGERS
  AGOS --> LEDGERS
  MCP -->|loopback HTTP| AGOS
```

- **`frontend/`** — Vite + React SPA. The DSH API contract is vendored and pinned (`UPSTREAM.pin`); `npm run verify` includes a zero-drift check against upstream.
- **`plugins/`** — five DSH plugins (plain ESM, host dependencies provided by the DSH profile). Cross-plugin coupling is file-level (shared ledgers), not import-level, with one documented exception.
- **`regression/`** — a 41-step full-site browser regression driven through a real Chrome instance, asserting *content* (not just clickability), plus the macOS app shell.
- **`scripts/`** — `iterate.sh` (build → deploy → restart-only-if-plugins-changed → health checks), `deploy-plugins.sh` (checksum-based drift detection), `test-all.sh`.

## 4. Getting Started

Requirements: a DSH host (DSH Desktop or `@deepseek-ai/dsh`), Node ≥ 22, and a DSH profile directory.

```bash
git clone https://github.com/LeoLin990405/agos && cd agos

# frontend
cd frontend && npm install && npm run build && cd ..

# plugins → your DSH profile (copies, not symlinks: the host resolves
# @deepseek-ai/* from the plugin file's realpath, so plugins must live
# inside the profile tree)
scripts/deploy-plugins.sh

# register the five plugins in your profile's package.json / cordis.patch.yml,
# then run the web host
dsh web --port 3091 --no-open
# → http://127.0.0.1:3091/agos/
```

Day-to-day iteration is one command:

```bash
scripts/iterate.sh   # build → deploy → restart 3091 only if plugin bytes changed → health checks
```

Frontend-only edits never need a restart — the SPA is read from disk per request.

## 5. Development

```bash
scripts/dev-links.sh   # once: node_modules links so plugin tests resolve host packages in-repo
scripts/test-all.sh    # frontend verify (incl. contract zero-drift) + 5 plugin suites + deploy drift
```

Test surface at a glance: **583** unit tests (286 frontend / 297 plugins), session-replay invariants over archived transcripts, byte-identical fold golden files, and the 41-step browser regression. The memory-ruler suite auto-skips when its locally generated corpus (built from your own session archives via `mine.mjs`) is not present.

## 6. Shadow Routing, in One Paragraph

When you review a fleet dispatch, AgOS asks a small model (StepFun `step-3.7-flash`, 1024 max tokens, one call) which machine *it* would pick — then does nothing with the answer except write it down. The ledger row records the suggestion, its reason, the candidates it saw, and whether it agreed with what you actually chose; if the batch later runs on the suggested machine, its terminal state backfills the row. Over time this produces the only thing that can honestly justify automated routing: a record of real decisions with real outcomes, accumulated *before* the selector is given any authority.

## License & Credits

- [MIT](LICENSE).
- The API contract under `frontend/src/contract/` is vendored from [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (MIT, © DeepSeek) and kept drift-free by `npm run vendor:diff`.
- Built to run on the DeepSeek Harness plugin runtime (`cordis`); host packages (`@deepseek-ai/*`) are provided by your DSH installation.
