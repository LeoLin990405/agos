# Final verification — 2026-09-08

**Scoped offline acceptance passed: 833 tests passed, 0 failed, 3 explicitly skipped.** The three skips require a private corpus and are not passes. The independent benchmark repeats three tests already included in dsh-agos; it is not added to the total.

Base: `24bc17e6892839190563defe15ec4ed4b573e934`. Branch: `cursor/agos-hardening-20260908`. Environment: macOS, Node 26.7.0, npm 11.19.0, DSH 0.1.2-rc.1 / pin `a66e470204`. Test commands, exact arguments, exit codes, durations and full-log SHA256 values are in [acceptance-results.json](acceptance-results.json). Logs below are the final synthetic-fixture runs after integration; preliminary private-corpus runs are excluded.

| Suite | Exit | Pass / Fail / Skip | Evidence |
|---|---:|---:|---|
| frontend-verify | 0 | 365 / 0 / 1 | [full log](logs/acceptance/frontend-verify.txt) |
| dsh-agos | 0 | 154 / 0 / 2 | [full log](logs/acceptance/dsh-agos.txt) |
| dsh-agos-router | 0 | 91 / 0 / 0 | [full log](logs/acceptance/dsh-agos-router.txt) |
| dsh-fleet | 0 | 137 / 0 / 0 | [full log](logs/acceptance/dsh-fleet.txt) |
| cn-capabilities | 0 | 82 / 0 / 0 | [full log](logs/acceptance/cn-capabilities.txt) |
| dsh-mcp-bridge | 0 | 4 / 0 / 0 | [full log](logs/acceptance/dsh-mcp-bridge.txt) |

`frontend-verify` includes installed-host version check, TypeScript check, frontend tests, isolated-worktree production build and vendor gate. All five plugin suites were run as `node --test test/*.mjs` in their own directories. Original checkout build output was not overwritten.

| Additional check | Result | Evidence |
|---|---|---|
| Scripts and negative controls | exit 0: failed producer remains failed; empty filter remains successful; missing pin exits 2; changed adapter contents fail; fake rsync failure cannot become zero drift | [log](logs/acceptance/scripts-selftest.txt) |
| Real Chrome component interactions | exit 0, six checks; Chrome 152.0.7977.82; no page errors | [log](logs/acceptance/browser-fixture.txt), [screenshot](artifacts/browser-fixture.png) |
| Secret-scanner scaling | exit 0, three synthetic input families at 4/8/16/32/100/200KB | [log](logs/acceptance/secrets-benchmark.txt) |
| Deployment dry-run | **exit 1, expected installed-copy drift**; no deployment performed | [log](logs/acceptance/deploy-check.txt) |

The browser fixture imports the real approval and history components, drives clicks in a fresh browser context and supplies synthetic state. Store/transport race tests exercise the actual live store separately. This does not prove the combined real-host chat workflow, real model calls, real remote SSH execution or deployed profile behavior.

The autoresearch verifier uses the installed macOS Seatbelt executable. Its real subprocess tests check filesystem, environment and network restrictions. Linux and hosts without this executor report `verification-unavailable`. Commands requiring network access or writes outside scratch cannot be verified by this policy. The policy is an OS capability boundary tested for these cases, not a claim of resistance to every sandbox escape.

The vendor gate verifies four wire constants against the pinned git object and freezes all 19 local adapter contents to reviewed base blobs. This protects against accidental adapter changes; it is not full upstream schema or runtime compatibility certification.

## Reproduce

Run after providing the pinned host dependency environment; node_modules links in this workstation were read-only inputs. Do not install through a link into another profile. A standalone dependency setup remains next-round work.

```sh
# From the hardening checkout. Do not set a private corpus path for synthetic acceptance.
(cd frontend && npm run verify)
(cd plugins/dsh-agos && node --test test/*.mjs)
(cd plugins/dsh-agos-router && node --test test/*.mjs)
(cd plugins/dsh-fleet && node --test test/*.mjs)
(cd plugins/cn-capabilities && node --test test/*.mjs)
(cd plugins/dsh-mcp-bridge && node --test test/*.mjs)
zsh scripts/test-all-selftest.sh
(cd plugins/dsh-agos && node test/secrets-gate-bench.mjs)
# Requires installed Playwright / Chromium, or explicit module and executable paths:
(cd frontend && node scripts/hardening-ui-smoke.mjs)
zsh scripts/deploy-plugins.sh --check
```

For this browser run, `AGOS_PLAYWRIGHT_MODULE` pointed to an existing local Playwright installation and `AGOS_BROWSER_EXECUTABLE` to Google Chrome. No package/browser download was performed. `AGOS_UI_SCREENSHOT` selects an optional output file. The controller left HOME unchanged, removed corpus/baseline-acceptance environment flags and explicitly supplied an absent temporary `SESSION_MEMORY_CORPUS_DIR`.

`scripts/test-all.sh` includes deployment drift, so an undeployed branch can exit nonzero after successful tests. The aggregate script was covered through its helper negative tests and constituent commands; it is not claimed to have exited zero in this round. `iterate.sh` was syntax/helper-tested only because its normal action deploys and restarts.
