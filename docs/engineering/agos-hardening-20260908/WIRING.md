> Historical implementation-stage record. Superseded by [final verification](VERIFICATION.md) and REVIEW.md. Old counts, pending items and script descriptions below are not current acceptance claims. Early raw logs are intentionally not published.

# Controller wiring notes

Written 2026-09-08 18:52 before helpers land. Insertion points are current-HEAD line numbers and will shift.

## CN `plugins/cn-capabilities/lib/index.js`

- Import A/B/I helpers at top with existing council-record import (~line 13).
- Replace `planPathOk` (~372) with `resolvePlanPath` / `openPlanFile`. GET/POST plan routes (~394 `readFile(PLAN_DIR + '/' + n)`) must use the same opener.
- `plan_run` execute (~1859–1916): after reading plan, `evaluatePlanApproval`. `approve:true` is not enough. `planFromFile` branch must still require bound approval.
- Autoresearch execute (~2425–2504): `createIsolatedAutoresearchWorkspace` around the loop; `extractStructuredMetric`; never `git add -A` in caller cwd.
- Council (~1610–1648) and vision parseFirstJsonObject (~748): `parseCouncilVerdict` / `evaluateCouncilStructure`. Keep string-aware JSON extract for vision text; schema check is after parse.

## Fleet `plugins/dsh-fleet/lib/index.js`

- Import `probeLocalRun` from C. Replace hardcoded local MISSING (~900) with live-set lookup (`LIVE_RUNS` / `runtime.controllerForRun`). Restart orphans stay MISSING/lost.
- Import F `validateFleetItems` in `fleet_run` execute (~660). Same MAX_ITEMS / MAX_ITEM_CHARS as HTTP. Reject, do not clip.
- Ledger constructor stays `createFleetLedger` — D should keep that export. No index change if lock is inside ledger.

## AgOS `plugins/dsh-agos/lib/index.js`

- `bindCatalogTrim` catalog callback (~1380): `defaultSkillRootDefs` is user-home only (`console-claude` / `user-dsh` / `user-agents`). Project skills live on the *runtime* skill-catalog message, not this audit list. H must keep project/unknown entries from `decision.messages[].source.entries`, not from the user-root candidate query. The callback can stay if rewrite is correct.
- `createTurnEvidenceStore` (~1374): if J adds persist flags / host turn ids, pass through `agent/pre-step` event fields only when present. HTTP `describeTurnEvidence` (~1591) should expose persisted vs observed.

## Router `plugins/dsh-agos-router/lib/index.js`

- `recordOutcome` (~301): run J `bindFeedback` before `buildOutcomeRecord`. Server sets source. Client source ignored except explicit operator `manual` after confirm.
- `shadow/link` handler: J shadow bind. Unused suggestion stays unknown.
- Dispatch verdict feed: J independence check; do not change models/thresholds.

## Frontend live / transcript / ChatPage (serial)

- `respondApproval` (~283): do not delete map or return success until `postEventResult` settles. Use E reducer; token callId+eventId+sessionId.
- Snapshot (~158): store header/hasMore/projections via G helper; keep fold apply order.
- Add `session/page` loader using `throughSeq: snapshot.cursor`.
- ChatPage (~190): richer health from G; replace leftover `events.mux` copy with `remote.mux` when wiring.
- Transcript approval (~640): pass E status/error/busy; `respond` becomes async.

## Known already-present hooks

- Fleet runtime already has `hasLiveController` and index already passes `LIVE_RUNS.has`. `_reconcileRun` still honors probe MISSING as lost — C must either change probe output for live locals or skip lost when controller is live. Prefer honest probe ALIVE.
- HTTP dispatch already has limits; tool path does not.
- Console routes/council already have stale flags; progress/skills do not.
