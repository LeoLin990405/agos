# AgOS hardening handoff — 2026-09-08

Status: **offline acceptance complete; prepared for the user-authorized branch upload and PR**. The Git hosting PR/branch is the publication record; no production deployment or main merge is included.

- Worktree: `/Users/leo/Projects/agos-cursor-hardening-20260908`
- Branch: `cursor/agos-hardening-20260908`
- Base: `24bc17e6892839190563defe15ec4ed4b573e934`
- Repository: https://github.com/LeoLin990405/agos
- Final results: **833 pass / 0 fail / 3 skip**, plus six real-browser component interactions, script negative controls, typecheck/build and pin guard.

## Delivered behavior

Autoresearch applies bounded patch proposals in an isolated candidate, verifies using a separate baseline and macOS sandbox, and exports an accepted patch/manifest before cleanup. Plans bind approval to current-session successful tool events, check safe file identity and report failed writeback honestly. Fleet holds concurrency through cancellation cleanup and uses cross-process owner locking. Frontend approval, connection, paging and evidence state now follows host identity and transport evidence. Secret classification avoids the observed quadratic inputs. Runtime skill trimming retains unknown/project sources. Router feedback and shadow binding use server provenance and task identity. Verification scripts preserve failures and adapter contents are frozen explicitly.

See [REVIEW.md](REVIEW.md) for findings/fixes, [VERIFICATION.md](VERIFICATION.md) for actual checks and limits, and [TASKS.md](TASKS.md) for final ownership. Historical Cursor records are retained with superseded banners.

## Next work, ordered

1. Reproducible isolated dependencies and separate code/deployment gates; make validation runnable away from this workstation.
2. Real pinned-host session/approval/paging integration using fake providers, with an actual browser flow.
3. Router cross-process transactions, collision-resistant IDs, original trial task identity and meaningful review context. This remains a text-trial system until actual code execution evidence is added.
4. Linux verifier sandbox with the same fail-closed contract and adversarial synthetic fixtures.
5. Remote artifact path replacement protection with fake transport coverage.
6. Memory/retrieval evaluation with synthetic Chinese fixtures; source provenance and same-name skill edge cases.

Fleet imports the shared task fingerprint helper from the router plugin; distribute these matching revisions together. The acceptance source differs from installed desktop/web copies. Future deployment requires a separate deliberate action and host validation.

The next Cursor prompt is to be supplied as complete copyable text. Do not automatically start another Cursor session. Use disjoint file owners, available subagent concurrency and non-author review, while retaining the controller as the sole shared-entry/document integrator.
