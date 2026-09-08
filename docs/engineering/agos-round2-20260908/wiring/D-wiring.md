# Package D — Linux autoresearch verification sandbox

**Branch:** `cursor/agos-round2-20260908` · **Base:** `7e7e359` · **Host:** Darwin 25.5.0 arm64, Node v26.7.0

> **Headline honesty statement.** The Linux OS-isolation executor added in this package was
> **NOT dynamically verified**. This machine has no Linux environment and no container
> runtime, so no Linux sandbox was ever launched. Everything Linux in this package is
> either *decision logic* driven by injected fake capability probes, or *static* assertions
> about the argv/env we would hand to the kernel. **Linux is not accepted this round.**

---

## 1. Files created / modified

| Path | Status | Role |
| --- | --- | --- |
| `plugins/cn-capabilities/lib/autoresearch-sandbox.mjs` | **created** (385 lines) | Capability probing, backend selection, fail-closed planning, Linux argv/env construction |
| `plugins/cn-capabilities/lib/autoresearch-workspace.mjs` | modified | Platform dispatch in `verificationSandbox`; generic `sandboxLauncher` in `execCommand`; boundary recorded in the manifest |
| `plugins/cn-capabilities/test/autoresearch-sandbox.test.mjs` | **created** (24 tests) | Linux selection + fail-closed decision logic, static argv/env assertions |
| `plugins/cn-capabilities/test/autoresearch-workspace.test.mjs` | modified (+2 tests) | Real-subprocess checks #6 (no orphan) and #7 (temp repos removed) |
| `docs/engineering/agos-round2-20260908/wiring/D-wiring.md` | **created** | This document |

No file outside package D's ownership was touched. `lib/index.js` was **not** modified —
the required wiring is proposed as an apply-ready diff in §4.

### Changes to `autoresearch-workspace.mjs`

1. `execCommand` gained an optional `sandboxLauncher` — `{ file, before[] }`, spawned as
   `file [...before, command]`. The pre-existing `sandboxProfile` option still expands to
   exactly the same argv it always did (`/usr/bin/sandbox-exec -p <profile> /bin/bash -c <cmd>`),
   so the Seatbelt path is byte-identical. Either option still means the child receives only
   the supplied env, with nothing inherited.
2. `execCommand` results now carry `pid`, which is what lets check #6 assert on the process group.
3. `verificationSandbox(evaluator, { platform, probe })` now dispatches on
   `chooseIsolationBackend(platform)` and accepts an injected probe. The macOS profile string
   is unchanged, and the macOS result gained a `launcher` alongside the existing `profile`.
4. The manifest records `verificationCapabilities` next to the existing `verificationBoundary`.

---

## 2. Linux isolation design

### Backends (in preference order)

**A. `linux-bubblewrap`** — `bwrap --unshare-all --new-session --die-with-parent --clearenv
--proc /proc --dev /dev --ro-bind-try <root> <root>… --ro-bind <evaluator> <evaluator>
--bind <scratch> <scratch> --setenv K V… --chdir <evaluator> -- /bin/bash -c <cmd>`

`--unshare-all` covers the user, ipc, pid, net, uts, cgroup and mount namespaces, so network
egress is removed by the kernel rather than by policy. Bind ordering is load-bearing and
asserted in tests: `scratch` lives *inside* the evaluator tree, so its read-write bind must be
applied **after** the read-only bind that would otherwise cover it.

**B. `linux-unshare`** (fallback) — `unshare --user --map-root-user --mount --net --pid --fork
--mount-proc -- /bin/bash -c <prelude> agos-verify <cmd>`, where the in-namespace prelude is:

```sh
set -eu
mount --make-rslave /                                    # never propagate back to the host
mount --bind / /
mount -o remount,bind,ro /                               # whole world read-only
mount --bind "$AGOS_VERIFY_SCRATCH" "$AGOS_VERIFY_SCRATCH"
mount -o remount,bind,rw,nosuid,nodev "$AGOS_VERIFY_SCRATCH"
cd "<evaluator>"
exec /bin/bash -c "$1"                                   # candidate command is $1, never spliced
```

The candidate command is passed as a positional argument, so a hostile command string is data,
not script. This is asserted statically.

### What the isolation restricts

| Property | Mechanism |
| --- | --- |
| Network egress | New empty net namespace (`--unshare-all` / `--net`); only a down `lo` exists |
| Environment inheritance | Explicit spawn env + `--clearenv`/`--setenv` for bwrap. No `HOME`, no tokens, no proxies, no `NODE_OPTIONS`, no `BASH_ENV` |
| Readable directories | Only `/usr`, `/bin`, `/sbin`, `/lib*`, the node prefix and the evaluator are bound. `/etc` and `$HOME` are deliberately **not** bound |
| Writable set | Exactly one path: the scratch directory. Everything else is a read-only bind or absent |
| Process containment | pid namespace + `--die-with-parent`, on top of the existing process-group kill |

### Capability probes and exact fail-closed reasons

Every probe is injectable (`systemProbe()` is the default implementation). Selection is by
explicit detection — `process.platform === 'linux'` only chooses *which probe set to run*, and
never on its own authorises a sandbox. Every rejection is prefixed `verification-unavailable: `.

| Probe | Source | Fail-closed reason when missing |
| --- | --- | --- |
| procfs | `/proc/self/status` | `linux isolation requires procfs mounted at /proc` |
| user ns | `/proc/self/ns/user` | `…requires a user namespace (/proc/self/ns/user missing)` |
| mount ns | `/proc/self/ns/mnt` | `…requires a mount namespace (/proc/self/ns/mnt missing)` |
| net ns | `/proc/self/ns/net` | `…requires a network namespace (/proc/self/ns/net missing)` |
| pid ns | `/proc/self/ns/pid` | `…requires a pid namespace (/proc/self/ns/pid missing)` |
| unpriv userns | `user.max_user_namespaces` | `…requires unprivileged user namespaces (user.max_user_namespaces=0)` |
| unpriv userns | `kernel.unprivileged_userns_clone` | `…requires unprivileged user namespaces (kernel.unprivileged_userns_clone=0)` |
| unpriv userns | `kernel.apparmor_restrict_unprivileged_userns` | `…requires unprivileged user namespaces (kernel.apparmor_restrict_unprivileged_userns=1)` |
| backend binary | `PATH` lookup | `…requires bubblewrap (bwrap) or unshare(1); neither is on PATH` |
| `mount(8)` | `PATH` lookup | `…via unshare requires mount(8) for read-only bind views` |
| unshare flags | `unshare --help` | `…requires unshare(1) support for <missing flags>` |
| bindable `/usr` | directory probe | `…requires a readable /usr to bind read-only` |
| live smoke | actually runs the built launcher | see below |

The three unprivileged-userns sysctls are skipped when `uid === 0`, since root already holds
`CAP_SYS_ADMIN`. An **absent** sysctl file is treated as "not configured", never as `0` —
`unprivileged_userns_clone` only exists on Debian-derived kernels, and reading its absence as
"disabled" would wrongly reject every other distribution. *(This was a real bug in my first
draft, caught by the decision-logic tests before it could ship.)*

### The live smoke test

Capability probes describe the kernel; they do not prove the sandbox holds. So the planner
runs the **actual constructed launcher** against a script with distinct exit codes, then
re-plans with the result:

```sh
set -u
printf ok > "$AGOS_VERIFY_SCRATCH/.agos-smoke" 2>/dev/null || exit 91
if printf x > /usr/.agos-smoke-should-fail 2>/dev/null; then rm -f /usr/.agos-smoke-should-fail; exit 92; fi
exit 0
```

| Outcome | Reason |
| --- | --- |
| no smoke result | `linux isolation smoke test did not run for <backend>` |
| smoke ran on another backend | `…smoke test ran on <x>, not the selected <y>` |
| exit 91 | `…smoke test failed for <backend>: scratch directory was not writable` |
| exit 92 | `…smoke test failed for <backend>: /usr was writable inside the sandbox` |
| any other non-zero | `…smoke test failed for <backend> (exit N): <last stderr line>` |

### seccomp — stated precisely

`seccomp` availability is **detected and recorded** (`Seccomp:` in `/proc/self/status`) but no
filter is installed. `bwrap --seccomp` requires a compiled BPF program on a file descriptor,
which this package does not ship. The plan therefore exposes `seccompAvailable` and a
hard-coded `seccompApplied: false`, and a test asserts that distinction so nobody can later
mistake availability for enforcement. seccomp is defence in depth here, not a precondition —
the namespaces are what enforce the boundary.

### D2 — no substitutes

There is no degraded mode anywhere in this path. `chooseIsolationBackend` returns `null` for
any platform that is neither darwin nor linux, and `verificationSandbox` then returns
`verification-unavailable: no OS isolation backend for platform <p>` **without** constructing a
launcher. A `cwd` setting, a command-string allowlist and a before/after hash comparison are
not offered as alternatives at any point. The pre-existing before/after materials hash in
`verifyCandidate` remains what it always was — a tamper *detector* layered on top of the OS
boundary, never a replacement for it, and it only runs once a real sandbox has been obtained.

---

## 3. Dynamically verified vs. static / decision-logic only

| DYNAMICALLY VERIFIED (real macOS Seatbelt subprocesses, this host) | STATIC / DECISION-LOGIC ONLY (no Linux runtime anywhere) |
| --- | --- |
| Outside-root sentinel is unreadable and unwritable (`EPERM`/`EACCES`) | That `bwrap --unshare-all` actually removes network egress on Linux |
| Evaluator/scoring files cannot be modified from inside the sandbox | That `mount -o remount,bind,ro /` actually yields a read-only view |
| Synthetic secret env vars are absent from the child process | That the rw scratch bind survives the ro root remount |
| Loopback TCP connect to a live local server is refused | That `--die-with-parent` / pid-ns actually reap descendants |
| Scratch directory writes succeed | That `--clearenv`/`--setenv` actually scrub the child env |
| Timeout cancellation leaves no orphaned process (group reaped) | That the unshare prelude runs at all on a real kernel |
| Temporary candidate + evaluator repos are removed after export | That `bwrap`/`unshare` exist, accept these flags, or exit 0 |
| macOS backend selection returns a working Seatbelt launcher | Backend selection for Linux (fake probes) |
| Non-darwin/non-linux platforms fail closed with no launcher | Every Linux fail-closed reason string (fake probes) |
| | The Linux smoke script's exit-code contract (fake probes) |
| | bubblewrap/unshare argv shape, bind ordering, env contents (pure functions) |

The right-hand column is exercised by 24 tests, and those tests are real — they caught a real
fail-closed bug. But they test **our decision-making about Linux**, not Linux. Nothing in the
right-hand column is evidence that the Linux sandbox isolates anything.

---

## 4. Exact wiring needed in `lib/index.js`

**No change to `index.js` is required for correctness.** `verificationSandbox` is called
internally by `verifyCandidate`, and all D changes are backward compatible — the plugin picks
up the Linux backend automatically if it is ever run on a capable Linux host.

The wiring below is requested for **operator visibility**: today the report never states which
OS boundary produced a result, and a `verification-unavailable` stop is reported with a message
that says the metric could not be parsed. Both are misleading.

Apply-ready, against `index.js` around line 2500:

```diff
         const baseMetric = measured.ok ? measured.metric : NaN
         lines.push('目标: ' + goal)
         lines.push('候选在临时隔离仓评估，原仓保持不变；成功修改导出为补丁。')
         lines.push('指标: ' + metric + '(' + direction + ') | baseline: ' + (measured.ok ? baseMetric : '解析失败:' + (measured.status || measured.reason || '')))
-        if (!measured.ok) { lines.push('[停止: baseline 指标无法解析]'); return outcome }
+        lines.push('验证边界: ' + (workspace.verificationBoundary || 'unavailable')
+          + (workspace.verificationCapabilities?.length ? ' [' + workspace.verificationCapabilities.join(',') + ']' : ''))
+        if (!measured.ok) {
+          // A missing OS boundary is not a metric problem; say so instead of blaming the parser.
+          lines.push(measured.status === 'verification-unavailable'
+            ? '[停止: 无可用的操作系统隔离边界，拒绝在无沙箱状态下验证] ' + (measured.reason || '')
+            : '[停止: baseline 指标无法解析]')
+          return outcome
+        }
```

And in the iteration loop, around line 2565, stop retrying once the boundary is gone — every
subsequent iteration would fail identically:

```diff
           } else if (iter.status === 'cancelled') {
             lines.push('第' + i + '轮 取消')
             break
+          } else if (iter.status === 'verification-unavailable') {
+            lines.push('第' + i + '轮 停止: 验证沙箱不可用 — ' + (iter.reason || ''))
+            break
           } else {
```

Neither hunk changes control flow for a healthy run: the first only adds report lines and
refines an existing stop message, the second adds a `break` on a status that currently loops
uselessly. Both are controller-owned; D did not apply them.

---

## 5. Commands run, real exit codes, counts

The suite state moved during this session: another agent installed `plugins/node_modules`
part-way through, and `lib/index.js` imports `@deepseek-ai/schemastery`. My very first
baseline run therefore predates that install and is *not* comparable to the after-state. I
report it anyway rather than quietly dropping it.

| # | Run | Command | Exit | tests | pass | fail | skip |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | First baseline attempt, **before** `plugins/node_modules` existed | `cd plugins/cn-capabilities && node --test test/*.mjs` | **1** | 60 | 57 | **3** | 0 |
| 2 | **BEFORE** (controlled A/B) | same, in `/tmp/d-ab-before` | **0** | **82** | **82** | **0** | 0 |
| 3 | **AFTER** (controlled A/B) | same, in `/tmp/d-ab-after` | **0** | **108** | **108** | **0** | 0 |
| 4 | AFTER (live worktree) | `cd plugins/cn-capabilities && node --test test/*.mjs` | **0** | **108** | **108** | **0** | 0 |

Run 1's three failures were all `ERR_MODULE_NOT_FOUND: Cannot find package
'@deepseek-ai/schemastery'` from `lib/index.js` (in `autoresearch-workspace.test.mjs`,
`media.test.mjs`, `plan-run.fake.test.mjs`) — an environment gap, not a code defect, and I did
not install anything to fix it.

Runs 2 and 3 are the honest attribution. Both trees were rsync'd from the same worktree seconds
apart with the same `plugins/node_modules` symlink; `diff -rq` confirmed they differ **only** in
package D's four files, with `lib/autoresearch-workspace.mjs` and
`test/autoresearch-workspace.test.mjs` restored from `7e7e359` on the BEFORE side. Run 2
reproduces the controller's stated baseline of 82/0/0 exactly.

**Net effect: 82 → 108 tests (+26), 0 → 0 failures, 0 → 0 skips, exit 0 → exit 0.**
The +26 are 24 in `autoresearch-sandbox.test.mjs` and 2 in `autoresearch-workspace.test.mjs`.
No existing test was deleted, skipped, weakened, or renamed.

---

## 6. The seven real-subprocess checks and how each is proven

Checks 1–5 are the pre-existing test `real OS sandbox denies outside reads/writes, verifier
writes, inherited secrets and network`, which spawns `node probe.cjs` under
`/usr/bin/sandbox-exec` and requires a single exact result object —
`{readOutside:true, writeOutside:true, writeVerifier:true, envClean:true, scratch:true, network:true}`.
Each flag is set by the child from a real syscall outcome, not by the parent.

| # | Check | How it is actually proven |
| --- | --- | --- |
| 1 | Outside-root sentinel unreadable **and** unwritable | Child `readFileSync`/`writeFileSync` on a sentinel outside the evaluator; flags true only for `EPERM`/`EACCES`. Parent then re-reads the file and asserts the bytes are unchanged |
| 2 | Scoring/evaluator files unmodifiable | Child writes to `evaluator/score.mjs`; parent asserts the content is still `trusted score` |
| 3 | Synthetic secrets not inherited | Parent sets `AGOS_SYNTHETIC_SECRET=test-only-not-a-real-secret`; child asserts `process.env.AGOS_SYNTHETIC_SECRET === undefined`. Synthetic value, never a real credential |
| 4 | Loopback network refused | Parent starts a **real** `net.createServer` on `127.0.0.1:<port>`; child's `net.connect` must fail with `EPERM`/`EACCES`. Connecting successfully sets the flag false and fails the test |
| 5 | Scratch writable | Child writes `$TMPDIR/allowed.txt`; a throw would crash the child and fail the `exitCode === 0` assertion |
| 6 | **Timeout leaves no orphan** | See below |
| 7 | **Temp candidate repo cleaned up after export** | See below |

### Check #6 — how I confirmed there is no orphan

The test spawns, under Seatbelt, `sleep 45 & echo $! > "$AGOS_VERIFY_SCRATCH/grandchild.pid"; wait`
with `timeoutMs: 1500`. `sleep` is a **grandchild**, so it survives unless the whole process
group is signalled. The assertion is on process liveness, not on promise rejection:

- The grandchild's real pid is read back from the file it wrote — proof it actually started.
- `assertReaped(grandchild)` polls `process.kill(pid, 0)` for up to 8s and requires `ESRCH`
  (`EPERM` is treated as *alive*, so a foreign-owned survivor cannot be mistaken for gone).
- `assertReaped(-result.pid)` does the same on the **negative** pid, i.e. the whole process
  group. `execCommand` spawns `detached: true`, so the wrapper pid is the process-group id.
- `result.exitCode` must not be `0`, so a command that merely finished cannot pass.

**Mutation-tested.** I copied the plugin to `/tmp/d-mutate`, changed `killProcessGroup` from
`process.kill(-child.pid, sig)` to `child.kill(sig)` (direct child only), and re-ran:

```
✖ a sandboxed timeout reaps the whole process group and leaves no orphan
  AssertionError: timeout did not reap the child: execCommand never settled
ℹ pass 0   ℹ fail 1        (exit 1)
```

The unmutated code passes the same test in 1.5s. The failure mode is itself the evidence: with
the group kill removed, the orphaned `sleep` keeps the inherited stdio pipe open, so
`execCommand` never settles at all. The first mutant run took 23 minutes to surface that, so I
added a 20s watchdog race and shortened the grandchild to `sleep 45`; the mutant now fails in
20s and cannot strand a process.

### Check #7 — how I confirmed cleanup

`process.env.TMPDIR` is pointed at a private `mkdtemp` root for the duration of the test (and
restored afterwards), so every temporary repo is attributable to this test alone — no
cross-test or cross-process races. After a full improve-and-export cycle the test asserts:

- `workRoot`, `isolatedDir` and `trustedDir` each `stat()` with `ENOENT`.
- **No** entry under the private root begins with `agos-autoresearch` — this covers the
  throwaway evaluator clone that `verifyCandidate` creates on *every* verification, not just
  the workspace itself.
- The exported patch and manifest still read back correctly after disposal, and the manifest's
  `verificationBoundary` matches `/^(macos-seatbelt|linux-bubblewrap|linux-unshare)$/`.

**Mutation-tested.** Replacing `verifyCandidate`'s `finally { await rm(root, …) }` with a no-op
produced:

```
✖ artifact export removes every temporary candidate and evaluator repo
  AssertionError: temporary repos survived: agos-autoresearch-eval-9OCuIx, agos-autoresearch-eval-UmnBWy
ℹ pass 0   ℹ fail 1
```

### Preserved from last round (re-confirmed green)

Tool-less patch proposals (`toolFilter: { allow: [] }`, no `cwd`); controlled patch application
via the allowlist; a separate trusted baseline evaluator; patch + manifest exported before
cleanup; plan-result writeback rechecking fingerprint and session and returning `persisted=0`
on failure. All still pass — run 3 above is 108/108 with zero failures.

---

## 7. Unresolved risks

1. **Linux is NOT dynamically accepted this round.** No Linux sandbox was launched. `docker`,
   `podman`, `colima`, `lima`, `limactl`, `nerdctl`, `vagrant`, `qemu-system-x86_64`, `bwrap`
   and `unshare` are all absent from this host (I re-verified all ten with `command -v`). The
   contract on this machine remains `verification-unavailable` for anything non-darwin.
2. **The `unshare` prelude is the least-tested code path.** `mount --bind / /` +
   `mount -o remount,bind,ro /` with a read-write scratch bind is a well-known recipe, but
   per-mount flag behaviour varies across kernels and distributions. Its *runtime* is entirely
   unproven. The smoke test's exit 92 exists precisely to catch a root that stays writable, but
   the smoke test itself has never run.
3. **`--die-with-parent` and the pid namespace are assumed, not measured.** Orphan reaping on
   Linux is claimed only by construction; check #6 proves it for Seatbelt only.
4. **`/etc` is deliberately not bound**, matching the macOS profile. Some toolchains want
   `/etc/nsswitch.conf` or `/etc/passwd`. If a real verifier command breaks on a Linux host,
   the fix is an explicit narrow read-only bind, not a wholesale `/etc`.
5. **`autoresearch-workspace.test.mjs`'s non-darwin branch is still not a Linux test.** I made
   it platform-honest (it now accepts either a fail-closed refusal or a `linux-*` kind and
   returns), but the five real-subprocess isolation assertions below it only ever run under
   Seatbelt. A Linux runner must extend that test, not just observe it pass.
6. **Environment instability.** `plugins/node_modules` appeared mid-session from a concurrent
   agent, and the install is only partially consistent (an intermediate run showed
   `@deepseek-ai/dsh-settings` missing an `installSettingsSection` export, breaking four
   `plan-run.fake.test.mjs` tests that are outside D's scope). Those failures are absent from
   the final full-tree runs, but the dependency state here is not reproducible.

### What environment would be needed to accept Linux

A real Linux runner — a CI job, VM or container on a Linux kernel — with:

- an unprivileged user namespace permitted (`user.max_user_namespaces > 0`, and on
  Ubuntu ≥ 23.10 either `apparmor_restrict_unprivileged_userns=0` or a matching AppArmor profile);
- `bubblewrap` installed (preferred) or `util-linux`'s `unshare` plus `mount`;
- mount, net and pid namespace support (i.e. not a locked-down nested container);
- permission to create bind mounts inside the namespace.

On such a host the correct next step is a Linux-only runtime suite that re-runs checks 1–7 as
**real spawned subprocesses** under `bwrap`/`unshare` — the exact same seven assertions Seatbelt
already satisfies here. Until that suite exists and passes on a real kernel, the Linux backend
must be treated as unproven, and any report claiming otherwise is wrong.
