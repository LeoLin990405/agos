# AgOS hardening — integrated acceptance review

Status: scoped offline acceptance PASS on 2026-09-08; no remaining blocker reported by the final scoped reviews. This document supersedes the historical Cursor phase reviews.

| Finding discovered during acceptance | Fix and evidence |
|---|---|
| Autoresearch used a spawn `cwd` field the host does not honor, and deleted successful results | Tool-less patch proposals; controlled patch application; separate baseline verifier; exported patch and manifest. Final OS isolation checks are recorded in VERIFICATION.md. |
| Inherited session events could authorize a child plan; writable open truncated before inode checks | Current `ownEvents` only, matching successful tool-result; no early O_TRUNC, parent/leaf identity checks, hardlink rejection; deterministic regression cases. |
| Council structural errors were not reliably inconclusive | Required schema and valid panel count checked in production entry. |
| Stale-lock recovery could remove a new owner; identity changed across time zones | Atomic hardlink owner publication, generation recovery locks, identity recheck, UTC/C process birth identity; true separate-process and cross-TZ tests. |
| Local cancel/timeout released concurrency before cleanup | Hold slot through result and disposal; shutdown settles queued and pre-start cancellation promises; actual plugin/fake runner tests. |
| Approval POST response could overwrite an earlier host decision/cancel | Session + call identity, generation guards, latest state reduction; real store/fake transport tests. |
| Follow errors and opening projections were lost; empty window hid paging | Independent ready/follow state; header/projections and live tail retained; real page calls and merge regression tests. |
| Historical turn evidence displayed latest session evidence | Full session/turn/step request and response identity; unknown remains unknown; durability is separately represented. |
| Redaction still scanned repeated keywords quadratically and had long-value regressions | Monotonic scanners; 100KB and 200KB three-pattern scaling; synthetic differential checks; escaped quote regressions. |
| Unknown-origin skills preserved everything but reported a trim | Real runtime snapshot winner/source mapping; project/unknown entries retained; no-op is not success. |
| Posterior filtering missed POST assemble; same model reviewer was still called | Filter at shared posterior entry and gate before reviewer invocation; actual HTTP/provider-zero-call regression. |
| Shadow could bind unrelated real batches | Shared full-task SHA256 before truncation, count/order/time checks, one-to-one binding, server-derived hosts, revalidated backfill. |
| Adapter file-name allowlist ignored changed schemas | All 19 adapter contents frozen to reviewed 24bc17e blobs plus pin wire constants; mutated-schema negative test. This is not full upstream type-equivalence proof. |
| Build/verify/rsync errors could become a green filtered result | Producer exit preserved, complete error diagnostics; both helpers and synthetic failing rsync tested. |
| Default tests read personal corpora | Synthetic fixtures by default; explicit dedicated corpus paths only; final evidence excludes preliminary runs. |

## Independent checks

- CN: final non-author review found no remaining concrete P1/P2 blocker. Real macOS sandbox subprocess tests deny outside-root sentinel reads/writes, evaluator writes and loopback network, omit synthetic inherited secrets and permit scratch writes. Plan result writeback rechecks fingerprint and current session; failure returns `persisted=0`. Full suite: 82/82.

- Fleet: router reviewer initially rejected cross-TZ identity; fixed and rechecked. Additional actual-plugin timeout test confirms slot is held through delayed result/disposal. PASS.
- Frontend: non-author review initially rejected cross-session approvals, baseline plan/preset and surface-replacement cases. Fixed and rechecked. Chrome fixture covers six component interaction paths; real-host E2E remains outside this result.
- AgOS: independent secret/runtime checks plus controller joint tests. No outstanding scoped blocker reported.
- Scripts: cursor_handoff_review independently checked the final scripts and all manifest hashes against the original commit, and ran selftests. PASS. Nested browser/server/cache cleanup added after the non-blocking cleanup comment.
- Gemini script review was attempted but returned no usable conclusion (workspace trust on first invocation, timeout on second). No Gemini approval is claimed.

## Scope limits retained

Router JSONL does not yet offer cross-process transactions. Ordinary text trials still require stronger task identity and full-context review. The adapter freeze is a regression guard, not complete host compatibility certification. Remote artifact directory replacement races, reproducible standalone dependencies and Linux verification sandbox support are next-round work. Real provider calls, production host workflows, machine power operations and deployment were not run.

## Test-data incident

Preliminary legacy tests automatically read personal session corpora before their default discovery was identified. No corpus body was added to these reports or uploaded. Those runs are excluded from acceptance. Defaults now use synthetic fixtures or require explicit corpus paths. Final tests leave private corpus checks skipped rather than claiming them as passed.
