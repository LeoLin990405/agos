# Linux isolation (bubblewrap) verification layer

Integration layer `linux`. Runs the **production** sandbox
(`linuxVerificationSandbox` in `plugins/cn-capabilities/lib/autoresearch-sandbox.mjs`)
against six required properties and writes a verdict to `<logdir>/linux.json`
following the round-4 integration-layer contract.

This entry deliberately contains **no sandbox implementation of its own**. It imports
the shipped module and records that module's sha256 in `moduleProvenance`, because a
parallel implementation could pass while the product's fails — the one failure mode a
verification entry must not have.

## Status on the machine this was written on

**`verdict: blocked`.** The authoring host is `Darwin 25.5.0 arm64` with no Linux
kernel, no container or VM runtime, and no `bwrap`. Seven of the eight required
capabilities are absent. That is an environment fact, not a code failure, and it is
reported as `blocked` — never merged into a pass. Installing a VM or container
runtime to remove the blocker would be a system-service install, which the round's
execution constraints forbid.

## Run it

```sh
# on a real Linux host, from the repo root
node scripts/acceptance/integration/linux/run-linux-isolation.mjs --logdir ./linux-layer-logs
```

| flag | effect |
|---|---|
| `--logdir <dir>` | where `linux.json`, the capability report and the console log go. Defaults to a fresh `mkdtemp`. |
| `--self-check-only` | run only the entry self-check; make no claim about any host capability. |
| `--strict-blocked` | exit `2` instead of `0` when the verdict is `blocked`. Use this in a pipeline that requires real coverage. |
| `--quiet` | do not echo the transcript (the artifact paths are still printed). |

Exit codes: `0` pass or blocked, `1` a real failure (a check failed, or the entry
self-check failed), `2` blocked under `--strict-blocked`.

Unit tests for the entry:

```sh
node --test scripts/acceptance/integration/linux/test/linux-layer.test.mjs
```

Node v26 rejects a bare directory passed to `--test`; pass explicit files or a glob
string, never `scripts/acceptance/integration/linux/test/`.

## Minimum environment

| requirement | minimum | why |
|---|---|---|
| kernel | Linux **≥ 3.8**, x86_64 or aarch64 | unprivileged user namespaces landed in 3.8. Every current distribution is far past it; the gate exists to name a genuinely ancient kernel rather than fail obscurely. |
| `bwrap` | bubblewrap, any version providing `--unshare-all --ro-bind-try --die-with-parent --new-session --clearenv` (0.4+; tested against 0.8-era flags) | the **only** accepted backend. |
| user namespaces | `/proc/self/ns/{user,mnt,net,pid}` present, and for a non-root uid: `user.max_user_namespaces != 0`, `kernel.unprivileged_userns_clone != 0`, `kernel.apparmor_restrict_unprivileged_userns != 1` | the namespaces are what actually enforce the boundary. An **absent** sysctl counts as "not configured" and is fine — only an explicit `0`/`1` blocks. |
| privileged? | **No.** | Unprivileged userns is enough. Under `uid 0` the sysctl gates are skipped because root already holds `CAP_SYS_ADMIN`. Running privileged is not required and does not make the result stronger. |
| mount primitives | mount namespace available; `/proc/filesystems` lists `tmpfs` and `proc` | needed for `--proc /proc`, `--dev /dev` and bubblewrap's tmpfs root. |
| filesystem | a readable `/usr` to bind read-only | the evaluator has to be able to execute something. |
| procfs | mounted at `/proc` | both the capability probe and the reaping evidence read it. |

### If you are using a container

A plain container usually **cannot** demonstrate this boundary: nesting user
namespaces needs the outer runtime to allow it, and most default profiles do not.
Concretely, you need the outer container to permit `unshare(CLONE_NEWUSER)` — for
example `docker run --security-opt seccomp=unconfined --security-opt apparmor=unconfined`,
or a rootless Podman setup where userns nesting already works. Ordinary `docker run`
with the default seccomp profile will make `bwrap` fail and this entry will report
`fail` (capabilities present, boundary did not hold) rather than `blocked`.

**Do not relax a shared, production or CI host's kernel policy to make this pass.**
If the environment you have cannot demonstrate the boundary, report the required
environment — that is what a `blocked` verdict is for.

### Distribution install

```sh
# Debian / Ubuntu
sudo apt-get install -y bubblewrap
# Fedora / RHEL
sudo dnf install -y bubblewrap
# Alpine
sudo apk add bubblewrap
# Arch
sudo pacman -S --noconfirm bubblewrap

bwrap --version
```

## Reproducing the conclusion from scratch

```sh
# 1. a Linux host meeting the table above
uname -srm
cat /proc/sys/user/max_user_namespaces
cat /proc/sys/kernel/unprivileged_userns_clone            2>/dev/null || echo 'not configured (fine)'
cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 'not configured (fine)'
bwrap --version

# 2. the repo at the round-4 baseline
git clone <this-repo> agos && cd agos
git checkout fix/cursor-integration-20260909

# 3. the layer entry — this is the one that produces the verdict
node scripts/acceptance/integration/linux/run-linux-isolation.mjs --logdir ./linux-layer-logs

# 4. read it
node -e 'const r=require("./linux-layer-logs/linux.json");
  console.log(r.verdict, JSON.stringify(r.countsByAssertionClass));
  for (const c of r.checks) console.log(c.verdict, c.id, c.assertionClass)'

# 5. the unit suites that back it
node --test plugins/cn-capabilities/test/autoresearch-sandbox.test.mjs
node --test scripts/acceptance/integration/linux/test/linux-layer.test.mjs
```

On a host that meets the table, expect `verdict: pass` with
`countsByAssertionClass["runtime-evidence"].pass == 4` and both
`process-group-reaped:timeout` and `process-group-reaped:abort` passing. Anything
less is reported per check, with the specific property that did not hold.

## The six properties

| # | property | assertion class |
|---|---|---|
| 1 | scratch is writable inside the sandbox | runtime evidence |
| 2 | a declared read-only bind is readable, and writes to it are refused | runtime evidence |
| 3 | a hand-made file **outside** every bind is unreadable | **vacuous without a positive control** |
| 4 | a live host loopback listener is unreachable | runtime evidence |
| 5 | on timeout and on cancellation the subprocess is reaped | runtime evidence |
| 6 | an insufficient host is refused as `verification-unavailable` | decision logic |

### Why item 3 needs a partner, and item 6 can never be runtime evidence

"The sandbox could not read file X" is **trivially true whenever X was never bound
into the sandbox** — and just as true on a host with no sandbox at all that simply
never had X in scope. An assertion like that goes green in an environment with zero
isolation, so on its own it is worthless as evidence.

The fix is a positive control built into the production smoke. Two sentinels are
created as **sibling files under one `mkdtemp` root**, and only `bound/` enters the
bind list:

```
<materials>/bound/bound-sentinel.txt     --ro-bind-try  ->  MUST be readable, with the expected bytes
<materials>/outside/outside-sentinel.txt not bound      ->  MUST be unreadable
```

Bind membership is now the **only** difference between the two files, which makes the
pair discriminating:

| host shape | in-scope sentinel | out-of-scope sentinel | result |
|---|---|---|---|
| real bind whitelist | readable | absent | both hold — real evidence |
| **no sandbox at all** | readable | **readable** | exit `93` — caught |
| binds never applied | **unreadable** | absent | exit `95` — caught, and the `93` pass is correctly not credited |
| host-root bind (the removed `linux-unshare` shape) | readable | **readable** | exit `93` — caught |

The positive control is probed **before** the negative one on purpose, so a sandbox
whose binds never applied fails naming the control instead of sailing past it. The
entry enforces the pairing independently: `checksFromManifest` reports item 3 as
covered only when `bound-bind-readable` is present **and** `verified` in the same
manifest. Delete the positive control and item 3 turns red rather than staying green
on a vacuous assertion.

Item 6 is decision logic and cannot be anything else: proving it needs a host that is
*missing* a capability, and degrading a real host to manufacture that is exactly the
environment surgery the constraints forbid. It is driven by injected capability
probes and labelled `decision-logic`, so it is never counted as runtime evidence.

Item 5's evidence is read from the **host's** `/proc`, not from inside the sandbox:
`--unshare-all` gives the sandbox its own PID namespace, so a pid captured inside it
(`$!`) is namespace-local and refers to a different process — or to nothing — on the
host. The grandchild is given a unique `argv[0]` instead, and it must be **observed
alive** before the kill; otherwise "the marker is gone" would be satisfied by a
grandchild that never started.

## The `linux-unshare` backend stays removed

An earlier round removed a `linux-unshare` fallback: it remounted the host `/`
read-only inside a mount namespace, so its read scope was the entire host —
`$HOME`, `/etc` and every credential stayed readable by candidate code. A remount is
not a read whitelist. It is pinned out by `=== undefined` assertions on the builder
exports and by a refusal that names the host read scope. **Nothing here restores it**,
and the entry's self-check asserts that an unshare-only host is still refused.

## Reading the result

`linux.json` fields worth knowing:

- **`verdict`** — `pass` | `fail` | `blocked` | `skipped`. `blocked` never rolls up
  into a pass; a partially blocked layer is `blocked`.
- **`countsByAssertionClass`** — read this, not `counts.pass`. A pass in the
  `decision-logic` class means the code decided correctly on an injected probe; it is
  not evidence that a kernel enforced anything.
- **`blockedReason`** — names every missing capability *and what was probed for it*.
- **`recoveryCommand`** — **one** flat argv, copyable, spawnable without re-parsing,
  which is what the contract field is and what the shared matrix validator checks.
  The prerequisites that must hold first are in **`recoverySteps`** (argv arrays), so
  nothing is lost by keeping the contract field single-valued.
- **`selfCheck`** — the entry self-check, on synthetic stubs, with
  `isRuntimeEvidence: false`. Kept in its own block so it can never be summed into
  the runtime counts.
- **`worktreeDigest`** — sha256 over the *current worktree bytes* of every tracked
  file, so an uncommitted edit moves it. Index- or commit-based digests would be
  identical for a clean checkout and a dirty one, which is the case the field exists
  to catch.
- **`logs[].sha256`** — computed from the bytes on disk, every run. A hand-written
  hash is worse than none: it looks like evidence.

## Entry self-check

The self-check runs on every host, including macOS, and is symmetric on purpose: a
usable stub must be **accepted**, and each deliberately broken stub must be
**refused for its own specific reason**. A self-check with only the accepting half
proves nothing, because an entry that accepts everything would pass it.

```sh
node scripts/acceptance/integration/linux/run-linux-isolation.mjs --self-check-only
```

It covers: a usable stub accepted; ten broken stubs refused (no `bwrap`,
unshare-only, and each distinct smoke failure); the entry's pairing gate rejecting a
manifest with a missing or `unproven` positive control; and every branch of the
reaping check, including its own positive control failing. None of it is runtime
evidence, and the label in the output says so.
