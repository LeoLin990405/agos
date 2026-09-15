// @dsh-local/fleet —— homelab 多机并发。
//
// 把**自包含**的子任务派到远端 `dsh --profile headless`、本机子代理或 Codex SDK 并行跑。
// remote 经 ssh+stdin；local 用进程内子代理；codex 只在显式选 host/tag 时走本机 SDK。
//
// ⚠️ 买得到什么(见 vault《21 实施计划》§C0):工具重的子任务(跑测试/编译/爬取/本地模型)、
// 隔离(一机一工作区一沙箱)、常驻 worker。**买不到**纯 LLM 吞吐——瓶颈是各家 API 的账号限流,
// 分到多机速度不变。所以 fleet_run 适合 tool-heavy / 需要隔离的任务;纯并行推理还是用 swarm_auto。
//
// ⚠️ 模型:worker 用它**自己 settings.yaml 的默认模型**(headless 没有 --model,--patch 覆盖也到不了
// 已构造的 agent-default-model —— 与 plan-mode 同一个"config 改动到不了已构造插件"的坑)。所以 v1 是
// **机器专精**:一台机固定一个模型,fleet 按需求模型挑对应的机;要改某机的模型就改它的 settings.yaml。
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseResultsXml, escapeXml, textOf, resolveProgressPublisher } from './fleet-swarm-compat.mjs'
import { createFleetLedger, scrubSecrets } from './fleet-ledger.mjs'
import { createFleetRuntime, TERMINAL_RUN_STATUSES } from './fleet-runtime.mjs'
import { registerFleetDispatchRoutes } from './fleet-dispatch.mjs'
import {
  buildArtifactFileCommand,
  createArtifactHandlers,
  parseArtifactStreamStatus,
  safeRelPath as safeArtifactRelPath,
  validateRunId,
} from './fleet-artifacts.mjs'
import { createFleetPower } from './fleet-power.mjs'
import { DEFAULT_CODEX_WORKSPACE, createCodexHostRunner } from './fleet-codex.mjs'
import { FLEET_GUIDANCE } from '../../dsh-agos/lib/agent-prompts.js'
import { validateFleetItems, InputLimitError } from '../../dsh-agos/lib/input-limits.js'
import { probeLocalRun } from './local-probe.mjs'

const name = '@dsh-local/fleet'
const inject = ['tools', 'subagents', 'commands', 'systemPrompt']

/** 进度通路不可用只警告一次:一个会话里可能跑几十批 fleet,每批一行会淹掉日志。 */
let PROGRESS_UNAVAILABLE_WARNED = false

const DEFAULT_HOSTS = [
  // kind:'local' = 本机进程内子代理;kind:'codex' = 本机 Codex SDK;kind:'remote' = ssh worker。
  // 三台 worker 均 dsh 0.1.0-rc.6、默认 DeepSeek、实测可跑工具任务(2026-08-19)。
  // leo-01/02 是 Linux,headless 对 cwd 是 workspace-write,写文件类任务能落地;agent-m4 是 macOS,写工作区外会被沙箱挡。
  { name: 'local', kind: 'local', model: 'deepseek-v4-flash', tags: ['general'], maxConcurrency: 3 },
  // Codex 只允许显式 hosts:[codex] 或 tag:codex 选中，默认批次绝不消耗它的额度。
  { name: 'codex', kind: 'codex', model: '', tags: ['codex'], workspace: DEFAULT_CODEX_WORKSPACE, maxConcurrency: 1 },
  { name: 'agent-m4', kind: 'remote', ssh: 'agent-m4', model: 'deepseek-v4-flash', tags: ['general', 'tool-heavy', 'mac'], maxConcurrency: 4 },
  { name: 'leo-01', kind: 'remote', ssh: 'leo-01', model: 'deepseek-v4-flash', tags: ['general', 'tool-heavy', 'linux', 'writable'], maxConcurrency: 6 },
  { name: 'leo-02', kind: 'remote', ssh: 'leo-02', model: 'deepseek-v4-flash', tags: ['general', 'tool-heavy', 'linux', 'writable'], maxConcurrency: 6 },
  { name: 'leo-03', kind: 'remote', ssh: 'leo-03', model: 'deepseek-v4-flash', tags: ['general', 'tool-heavy', 'linux', 'writable'], maxConcurrency: 6 },
  // knowledge-m4 常态是 QMD 单写机;放进池只给它轻量 tool-heavy 活,并发压到 2,别和 embedding 抢。
  { name: 'knowledge-m4', kind: 'remote', ssh: 'knowledge-m4', model: 'deepseek-v4-flash', tags: ['general', 'tool-heavy', 'mac', 'writable', 'knowledge'], maxConcurrency: 2 },
]

const DEFAULT_POWER_NODES = {
  'agent-m4': 'm4-a',
  'knowledge-m4': 'm4-b',
  'leo-01': 'leo-01',
  'leo-02': 'leo-02',
  'leo-03': 'leo-03',
}

const Config = z.object({
  enabled: z.boolean().default(true),
  announceToAgent: z.boolean().default(true),
  hosts: z.array(z.object({
    name: z.string(),
    kind: z.string().default('remote'),        // 'local' | 'remote' | 'codex'
    ssh: z.string().default(''),               // ssh alias(remote 必填)
    model: z.string().default(''),             // 该机默认模型(仅记录/展示,worker 实际用它 settings.yaml 的)
    tags: z.array(z.string()).default([]),
    maxConcurrency: z.number().default(3),
    enabled: z.boolean().default(true),
    workspace: z.string().default(''),         // 该机的"虚拟电脑"工作区(留空 = 用全局 workspace)
  })).default(DEFAULT_HOSTS),
  envFile: z.string().default('~/.config/cc-model-secrets.env'),
  // 每台机的持久工作区("虚拟电脑"):worker 的任务都 cd 到这里跑,文件跨任务留存、写得进(cwd 内 = 可写)。
  // 留 `~` 字面量给远端展开(见 runRemote 里那个"~ 不能在本机展开"的坑)。
  workspace: z.string().default('~/dsh-workspace'),
  sshConnectTimeoutSec: z.number().default(10),
  taskTimeoutMs: z.number().default(900000),
  globalMaxConcurrency: z.number().default(8),
  powerNodes: z.dict(z.string()).default(DEFAULT_POWER_NODES),
  // 唤醒网关(WoL 中转)是部署配置,不进源码:真实值写在插件 bundle patch 的 config 里(不进公开仓的部署侧)
  wakeGateway: z.string().default(''),
  wakeCommand: z.string().default('/usr/local/sbin/fleet-wake'),
  wakeBudgetMs: z.dict(z.number()).default({ 'm4-a': 45000, 'm4-b': 45000, _default: 120000 }),
  wakePollMs: z.number().default(5000),
  sleepCommand: z.string().default(join(homedir(), 'bin', 'fleetpower')),
  sleepAllowedHosts: z.array(z.string()).default(['leo-03']),
})

const SECTION_ORDER = 206
const HEALTH_TTL_MS = 60_000
const GUIDANCE = FLEET_GUIDANCE

const clip = (s, n) => { const t = String(s ?? ''); return t.length > n ? t.slice(0, n) + '…' : t }

function apply(ctx, config, dependencies = {}) {
  const cfg = () => ({ ...Config(config ?? {}) })
  const disposers = []
  const reg = (tool) => disposers.push(ctx.tools.register(tool))
  const hostsOf = () => (cfg().hosts ?? []).filter((h) => h.enabled !== false)
  const HEALTH = new Map()   // name → { at, ok, version, error }
  const PROBES = new Map()   // name → 正在进行的 probe Promise，冷缓存并发请求只发一次 ssh
  const EXECUTIONS = new Map() // runId → 本进程中可启动/等待结算的完整 prompt 与承诺
  const LIVE_RUNS = new Set() // runner 已真正挂上 abort listener 的 runId
  const LOCAL_SETTLEMENTS = new Map() // runId → plugin dispose 必须等待的本机子代理/SDK 执行
  const WAKE_WAITS = new Map()
  const STARTING_RUNS = new Map() // runId → host，关闭 markStart fsync 窗口的重入间隙
  let runtime = null
  let power = null
  let runtimeReady = Promise.resolve()
  let pumpPromise = null
  let pumpAgain = false
  let shuttingDown = false
  // SSH multiplexing 只保留 60s，既降低 trace 轮询的握手开销，也让换网后的旧 master 自然过期。
  // 测试可用环境变量把状态目录定向临时目录，生产默认始终是 ~/.dsh/logs/fleet/ssh/ 。
  const sshStateDir = process.env.DSH_FLEET_SSH_STATE_DIR || join(homedir(), '.dsh', 'logs', 'fleet', 'ssh')
  mkdirSync(sshStateDir, { recursive: true, mode: 0o700 })
  chmodSync(sshStateDir, 0o700)
  const sshOptions = (connectTimeout) => [
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${connectTimeout}`,
    '-o', 'ControlMaster=auto',
    '-o', `ControlPath=${join(sshStateDir, 'cm-%C')}`,
    '-o', 'ControlPersist=60',
  ]
  const RUNS_KEEP = 12
  const newRunId = () => 'r-' + randomUUID()
  const REMOTE_KILL_FLIGHTS = new Map()
  const codexRunner = dependencies.codexRunner || createCodexHostRunner({ scrubSecrets })

  // 取消先看 exit，防止远程进程已结束后 pid 被复用时误杀无关进程。这个命令不读任何远程凭据。
  const remoteKill = (host, runDir) => {
    const key = host.name + '\0' + runDir
    const existing = REMOTE_KILL_FLIGHTS.get(key)
    if (existing) return existing
    const flight = new Promise((resolve) => {
      let child
      const dir = remoteShellPath(runDir)
      const command = [
        `d=${dir}`,
        'if [ -f "$d/exit" ]; then printf "SETTLED\\n"; exit 3; fi',
        'p=$(cat "$d/pid" 2>/dev/null)',
        'case "$p" in ""|*[!0-9]*) printf "NO_PID\\n"; exit 4;; esac',
        'if ! kill -0 "$p" 2>/dev/null; then printf "NO_PID\\n"; exit 4; fi',
        'if [ -f "$d/exit" ]; then printf "SETTLED\\n"; exit 3; fi',
        'if ! kill -TERM "$p" 2>/dev/null; then [ -f "$d/exit" ] && { printf "SETTLED\\n"; exit 3; }; printf "TERM_FAILED\\n"; exit 5; fi',
        'n=0; while kill -0 "$p" 2>/dev/null && [ "$n" -lt 20 ]; do [ -f "$d/exit" ] && { printf "SETTLED\\n"; exit 3; }; sleep 0.1; n=$((n + 1)); done',
        'if ! kill -0 "$p" 2>/dev/null; then printf "KILLED\\n"; exit 0; fi',
        'if [ -f "$d/exit" ]; then printf "SETTLED\\n"; exit 3; fi',
        'if ! kill -KILL "$p" 2>/dev/null; then if ! kill -0 "$p" 2>/dev/null; then printf "KILLED\\n"; exit 0; fi; printf "KILL_FAILED\\n"; exit 6; fi',
        'n=0; while kill -0 "$p" 2>/dev/null && [ "$n" -lt 20 ]; do [ -f "$d/exit" ] && { printf "SETTLED\\n"; exit 3; }; sleep 0.1; n=$((n + 1)); done',
        'if kill -0 "$p" 2>/dev/null; then printf "STILL_ALIVE\\n"; exit 6; fi',
        'printf "KILLED\\n"; exit 0',
      ].join('; ')
      try {
        child = spawn('ssh', [...sshOptions(6), host.ssh, command], { stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (error) { resolve({ ok: false, error: String(error?.message ?? error) }); return }
      let out = '', err = '', done = false
      const finish = (value) => { if (done) return; done = true; clearTimeout(timer); resolve(scrubSecrets(value)) }
      const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch {}; finish({ ok: false, error: 'kill transport timeout' }) }, 12000)
      child.stdout.on('data', (chunk) => { if (out.length < 200) out += String(chunk).slice(0, 200 - out.length) })
      child.stderr.on('data', (chunk) => { if (err.length < 500) err += String(chunk).slice(0, 500 - err.length) })
      child.on('error', (error) => finish({ ok: false, error: String(error?.message ?? error) }))
      child.on('close', (code) => {
        const marker = out.trim().split(/\s+/, 1)[0]
        if (code === 0 && marker === 'KILLED') finish({ ok: true, state: 'killed' })
        else if (marker === 'SETTLED') finish({ ok: false, settled: true, state: 'settled', error: 'remote run already settled' })
        else finish({ ok: false, state: marker || 'transport-error', error: err.trim() || marker || ('kill ssh exit ' + code) })
      })
    })
    REMOTE_KILL_FLIGHTS.set(key, flight)
    void flight.finally(() => {
      const timer = setTimeout(() => { if (REMOTE_KILL_FLIGHTS.get(key) === flight) REMOTE_KILL_FLIGHTS.delete(key) }, 1000)
      timer.unref?.()
    })
    return flight
  }

  // ── 单机执行 ────────────────────────────────────────────────────────────
  // remote:ssh 到 worker,任务经 stdin 传(worker `"$(cat)"` 读回来当一个 argv,
  //   无需 base64、无 quoting 风险);先 source 凭据 env(非交互 shell 不自动加载)。
  // local:进程内子代理(不 ssh),等价于本机 swarm 的一格,给"把一部分留本机"用。
  const runRemote = (host, prompt, signal, assignment = {}) => new Promise((resolve) => {
    const c = cfg()
    const t0 = Date.now()
    const runId = assignment.runId || newRunId()
    const timeoutMs = Number(assignment.timeoutMs) > 0 ? Number(assignment.timeoutMs) : c.taskTimeoutMs
    if (signal?.aborted) {
      resolve({ ok: false, cancelled: true, text: '', error: '已取消（未启动）', ms: 0, host: host.name, runId })
      return
    }
    // ⚠️ envFile 里的 `~` 绝不能在**本机**展开 —— 那会得到本机(Mac)的 /Users/leo/...,
    //   发到 Linux worker(/home/leo-1)上不存在,`source` 静默失败→worker 没凭据→MISSING_CREDENTIAL。
    //   agent-m4 也是 Mac(同 /Users/leo)所以侥幸能过,leo-01/02 就露馅了(2026-08-19 花了很久才抓到)。
    //   留 `~` 字面量给**远端** shell 展开成它自己的家目录。
    const env = String(c.envFile || '~/.config/cc-model-secrets.env')
    // leo-01/02 的非交互 ssh PATH 里没有 ~/.npm-global/bin(实测),裸 dsh 会 command not found。
    // 先把它拼进 PATH(agent-m4 已在 PATH 里,重复无害)。任务 stdout/stderr/exit 都先落到 runDir，
    // 控制机合盖、换网或 ssh 断开不会带走远程 dsh，重贴时仍能取回结果。
    const ws = String(host.workspace || c.workspace || '~/dsh-workspace')   // 虚拟电脑:活在这台机的持久工作区里跑,文件跨任务留存、cwd 内可写
    // v2 实时轨迹:让 worker 把**明文 append-only 会话日志**写进工作区内独立新 root `<ws>/.trace`,
    //   面板 tail 它 → 真·工具级实时轨迹(headless 不吐流,但会话事件实时落盘;compression:'none' 是
    //   DSH 文档给"外部行读取器"的官方路径)。fresh 独立 root 不碰 worker 现有 zstd 会话(一 root 一编码,
    //   新 root 无冲突)。overlay 里用 `$PWD`(cd 后=绝对工作区)避开 `~` 不展开的坑;compression:'none' 已 dump-config 验过。
    // ── 每任务独立运行目录(审计 2026-08-20):同机并发原来共用同一 ~/dsh-workspace 与同一 .trace 根,
    //    文件互相覆盖、trace 按 mtime 在多会话间抖动、客户端 seq 跨 session 碰撞。现在:
    //    cwd = <ws>/tasks/<runId>(产物落这里,工作区根仍是"整台电脑"可浏览),trace root = <ws>/tasks/<runId>/.trace,
    //    pid 写 <ws>/tasks/<runId>/pid 给远端取消用。全部 POSIX(mkdir / printf / trap / wait),不依赖 GNU。
    const runDir = assignment.runDir || `${ws}/tasks/${runId}`
    const runDirArg = remoteShellPath(runDir)
    const traceDirArg = remoteShellPath(runDir + '/.trace')
    const overlayArgs = ["'- id: session-persistence-jsonl'", "'  config:'", "'    compression: none'", '"    root: $PWD/.trace"'].join(' ')
    const remoteCmd = [
      'export PATH="$HOME/.npm-global/bin:$PATH"',
      `if [ -r ${env} ]; then . ${env} 2>/dev/null; fi`,
      `mkdir -p ${traceDirArg} && cd ${runDirArg} || exit 7`,
      `printf '%s\\n' ${overlayArgs} > .trace/patch.yml`,
      // 后台 dsh 的 pid 在启动后单独写入 pid，remoteKill 仍可精确取消。
      "trap '' HUP",
      // 必须在 dsh 后台化之前把 ssh stdin 读完，否则子进程会继承尚未关闭的管道。
      'p="$(cat)"',
      'dsh --profile headless --patch .trace/patch.yml "$p" >out.txt 2>err.txt </dev/null &',
      'w=$!',
      'printf %s "$w" > pid',
      'wait "$w"',
      'rc=$?',
      'printf %s "$rc" > exit',
      // 保持 runRemote 的旧契约：ssh stdout 仍是 dsh stdout，失败时 stderr 最多回显 2000 字节。
      'cat out.txt',
      '[ "$rc" -eq 0 ] || head -c 2000 err.txt >&2',
      'exit "$rc"',
    ].join('\n')
    const child = spawn('ssh', [
      ...sshOptions(c.sshConnectTimeoutSec),
      '-o', 'ServerAliveInterval=30',
      host.ssh, remoteCmd,
    ], { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = '', err = '', done = false, cancelRequested = false
    const finish = (raw) => {
      if (done) return; done = true; clearTimeout(timer)
      const r = scrubSecrets(raw)
      signal?.removeEventListener?.('abort', onAbort); resolve({ ...r, runId })
    }
    // ⚠️ 审计(2026-08-20):取消/超时原来只 kill 本机 ssh 客户端;无 pty 的情况下远端 `exec dsh` 只会在下一次
    //   写 stdout 时吃 SIGPIPE,而 headless 只在最后打印一行 → 整段 agent 循环照跑到底(继续烧配额、继续写工作区)。
    //   现在先 ssh 回去按 pid 文件 kill(TERM,2s 后 KILL),仅凭确认进程消失的回执结算；
    //   kill 传输失败保持 detached/cancelPending，由 reconciler 后续重试。
    let killPromise = null
    const killRemoteOnce = () => {
      if (!killPromise) killPromise = remoteKill(host, runDir)
      return killPromise
    }
    const onAbort = () => {
      cancelRequested = true
      void killRemoteOnce().then((killed) => {
        if (done) return
        try { child.kill('SIGTERM') } catch {}
        finish(killed.ok
          ? { ok: false, cancelled: true, text: '', error: '已取消', ms: Date.now() - t0, host: host.name }
          : { ok: false, detached: true, text: out.trim(), error: killed.error || 'remote cancel failed', ms: Date.now() - t0, host: host.name })
      })
    }
    const timer = setTimeout(() => {
      if (cancelRequested) return
      void killRemoteOnce().then((killed) => {
        if (done) return
        try { child.kill('SIGTERM') } catch {}
        finish(killed.ok
          ? { ok: false, timedOut: true, text: out.trim(), error: '超时(' + Math.round(timeoutMs / 1000) + 's)', ms: Date.now() - t0, host: host.name }
          : { ok: false, detached: true, text: out.trim(), error: 'timeout remote kill failed', ms: Date.now() - t0, host: host.name })
      })
    }, timeoutMs)
    if (signal) { if (signal.aborted) return onAbort(); signal.addEventListener('abort', onAbort, { once: true }) }
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    // An ssh transport can close before a large prompt finishes writing. Without
    // this listener Node raises an unhandled EPIPE on child.stdin and terminates
    // the host process. Preserve the error for close classification: exit 255
    // remains detached, while ordinary non-zero exits remain failed.
    child.stdin.on('error', (e) => { err += (err ? '\n' : '') + 'ssh stdin: ' + String(e?.message ?? e) })
    child.on('error', (e) => {
      if (cancelRequested) { err += (err ? '\n' : '') + String(e?.message ?? e); return }
      finish({ ok: false, text: '', error: 'ssh 启动失败:' + String(e?.message ?? e), ms: Date.now() - t0, host: host.name })
    })
    child.on('close', (code) => {
      if (cancelRequested) return
      const text = out.trim()
      const error = (err.trim() || ('exit ' + code)).slice(0, 500)
      const detached = code === 255 || /connection\b[^\n]*(?:closed|reset|timed out)|connection timed out/i.test(err)
      finish(detached
        ? { ok: false, detached: true, text, error, exit: code, ms: Date.now() - t0, host: host.name }
        : (code === 0 && text
            ? { ok: true, text, error: '', exit: 0, ms: Date.now() - t0, host: host.name }
            : { ok: false, text, error, exit: code, ms: Date.now() - t0, host: host.name }))
    })
    try { child.stdin.end(prompt) } catch (e) { err += (err ? '\n' : '') + 'ssh stdin: ' + String(e?.message ?? e) }
  })

  const runLocal = async (host, prompt, signal, exec) => {
    const t0 = Date.now()
    let run, outcome, cleanupError
    try {
      run = await ctx.subagents.start('spawn', { parent: exec.agent, prompt: [{ type: 'text', text: prompt }], signal, label: 'fleet:local' })
      const res = await run.result
      const text = textOf(res).trim()
      outcome = { ok: !!text, text, error: text ? '' : ('无输出(' + res.stopReason + ')') }
    } catch (error) {
      outcome = { ok: false, text: '', error: String(error?.message ?? error) }
    } finally {
      try { await run?.dispose() } catch (error) { cleanupError = String(error?.message ?? error) }
    }
    const base = { host: host.name, ms: Date.now() - t0 }
    if (cleanupError) return { ...base, ok: false, text: '', error: 'local cleanup failed: ' + cleanupError }
    if (signal?.aborted) {
      return String(signal.reason) === 'TIMEOUT'
        ? { ...base, ok: false, text: '', timedOut: true, error: 'TIMEOUT' }
        : { ...base, ok: false, text: '', cancelled: true, error: '已取消' }
    }
    return { ...base, ...outcome }
  }

  const runOnHost = (host, prompt, signal, exec, assignment = {}) =>
    (host.kind === 'local'
      ? runLocal(host, prompt, signal, exec)
      : host.kind === 'codex'
        ? codexRunner.run(host, prompt, signal, assignment)
        : runRemote(host, prompt, signal, assignment))

  // ── 健康预检 ────────────────────────────────────────────────────────────
  const probeHost = (host) => new Promise((resolve) => {
    if (host.kind === 'local') { const r = { at: Date.now(), ok: true, version: 'in-process' }; HEALTH.set(host.name, r); return resolve(r) }
    if (host.kind === 'codex') {
      void codexRunner.probe(host).then((r) => { HEALTH.set(host.name, r); resolve(r) }, (error) => {
        const r = { at: Date.now(), ok: false, error: scrubSecrets(error?.message ?? error) }
        HEALTH.set(host.name, r); resolve(r)
      })
      return
    }
    // 同 runRemote:leo-01/02 的 ssh PATH 没有 ~/.npm-global/bin,探测也要先拼上,否则健康机被误判成"未装 dsh"
    const child = spawn('ssh', [...sshOptions(8), host.ssh, 'export PATH="$HOME/.npm-global/bin:$PATH"; command -v dsh >/dev/null && dsh --version 2>/dev/null || echo NO_DSH'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    const t = setTimeout(() => { try { child.kill() } catch {} }, 12000)
    child.stdout.on('data', (d) => { out += d }); child.stderr.on('data', (d) => { err += d })
    child.on('error', (e) => { clearTimeout(t); const r = { at: Date.now(), ok: false, error: String(e?.message ?? e) }; HEALTH.set(host.name, r); resolve(r) })
    child.on('close', (code) => {
      clearTimeout(t)
      const v = out.trim()
      const r = code === 0 && v && v !== 'NO_DSH'
        ? { at: Date.now(), ok: true, version: v }
        : { at: Date.now(), ok: false, error: (v === 'NO_DSH' ? '未装 dsh' : (err.trim() || ('exit ' + code))).slice(0, 200) }
      HEALTH.set(host.name, r); resolve(r)
    })
  })
  const probeOne = (host, { refresh = false } = {}) => {
    const now = Date.now()
    const cached = HEALTH.get(host.name)
    if (!refresh && cached && now - cached.at < HEALTH_TTL_MS) return Promise.resolve(cached)
    const pending = PROBES.get(host.name)
    if (pending) return pending
    const probe = probeHost(host).then((result) => {
      if (host.kind === 'remote') power?.setReachability?.(host.name, result)
      return result
    }).finally(() => {
      if (PROBES.get(host.name) === probe) PROBES.delete(host.name)
    })
    PROBES.set(host.name, probe)
    return probe
  }
  const probeAll = async ({ refresh = false } = {}) => {
    await Promise.all(hostsOf().map((host) => probeOne(host, { refresh })))
    return HEALTH
  }

  // All tool and UI batches share this process-wide pump. A detached run stays
  // active in FleetRuntime and therefore keeps its global/host slot until the
  // reconciler proves it terminal.
  const hostByName = (hostName) => hostsOf().find((host) => host.name === hostName)
  const hostInflight = (hostName) => runtime
    ? runtime.listRuns().filter((run) => run.host === hostName && (run.status === 'running' || run.status === 'detached')).length
    : 0
  const hostPowerReservations = (hostName) => {
    const reserved = new Set((runtime?.listRuns?.() || [])
      .filter((run) => run.host === hostName && !TERMINAL_RUN_STATUSES.has(run.status))
      .map((run) => run.runId))
    for (const [runId, name] of STARTING_RUNS) if (name === hostName) reserved.add(runId)
    return reserved.size
  }

  const chooseAssignments = (chosenHosts, count) => {
    const allRuns = runtime?.listRuns?.() || []
    const load = new Map(chosenHosts.map((host) => [host.name,
      allRuns.filter((run) => run.host === host.name && !TERMINAL_RUN_STATUSES.has(run.status)).length]))
    const assigned = []
    for (let index = 0; index < count; index++) {
      const host = [...chosenHosts].sort((left, right) => {
        const leftLoad = load.get(left.name) || 0
        const rightLoad = load.get(right.name) || 0
        return (leftLoad / Math.max(1, Number(left.maxConcurrency) || 3)) -
          (rightLoad / Math.max(1, Number(right.maxConcurrency) || 3)) ||
          leftLoad - rightLoad || left.name.localeCompare(right.name)
      })[0]
      assigned.push(host)
      load.set(host.name, (load.get(host.name) || 0) + 1)
    }
    return assigned
  }

  const resultFromRun = (run) => ({
    ok: run?.status === 'completed',
    text: run?.resultText || '',
    error: run?.status === 'cancelled' ? '已取消' : (run?.error || String(run?.status || '未知错误')),
    ms: Number(run?.ms) || (run?.startedAt && run?.endedAt ? Math.max(0, run.endedAt - run.startedAt) : 0),
    host: run?.host || '',
    runId: run?.runId || '',
    detached: run?.status === 'detached',
  })

  const publishExecution = (run, forcedStatus) => {
    const execution = EXECUTIONS.get(run?.runId)
    if (!execution?.rows) return
    const current = execution.rows[execution.index]
    if (!current) return
    const status = forcedStatus || run.status
    execution.rows[execution.index] = {
      ...current,
      status: status === 'cancelled' ? 'failed' : status,
      host: run.host,
      provider: run.host,
      model: hostByName(run.host)?.model || run.model || null,
      elapsedMs: resultFromRun(run).ms,
    }
    try { execution.publish?.(execution.rows) } catch {}
  }

  const settleExecution = (run) => {
    if (!run || !TERMINAL_RUN_STATUSES.has(run.status)) return false
    const execution = EXECUTIONS.get(run.runId)
    if (!execution) return false
    publishExecution(run)
    EXECUTIONS.delete(run.runId)
    try { execution.resolve?.(resultFromRun(run)) } catch {}
    return true
  }

  const waitForWakingRun = (run) => {
    if (!power || WAKE_WAITS.has(run.runId)) return
    const signal = runtime.controllerForRun(run.runId).signal
    const wait = power.waitForWake(run.host, { signal }).then(async (outcome) => {
      const current = runtime.getRun(run.runId)
      if (!current || TERMINAL_RUN_STATUSES.has(current.status)) return
      if (outcome?.ok) {
        await runtime.markQueued(run.runId, { wakeState: 'ready' })
        return
      }
      if (!current.pinned) {
        await probeAll({ refresh: true })
        const alternatives = hostsOf().filter((host) => host.kind === 'remote' && host.name !== current.host &&
          HEALTH.get(host.name)?.ok && (!current.tag || (host.tags || []).includes(current.tag)))
        if (alternatives.length) {
          const [target] = chooseAssignments(alternatives, 1)
          await runtime.rerouteRun(run.runId, {
            host: target.name,
            kind: target.kind,
            model: target.model || '',
            runDir: runDirOf(target, run.runId),
          })
          return
        }
      }
      await runtime.markEnd(run.runId, { ok: false, error: scrubSecrets(outcome?.error || outcome?.code || 'WAKE_TIMEOUT') })
    }).catch(async (error) => {
      const current = runtime.getRun(run.runId)
      if (current && !TERMINAL_RUN_STATUSES.has(current.status)) {
        await runtime.markEnd(run.runId, { ok: false, error: scrubSecrets(error?.message ?? error) })
      }
    }).finally(() => {
      WAKE_WAITS.delete(run.runId)
      runtime?.wakePump?.('wake-settled')
    })
    WAKE_WAITS.set(run.runId, wait)
  }

  const executeRegisteredRun = async (queued) => {
    const execution = EXECUTIONS.get(queued.runId)
    const host = hostByName(queued.host)
    if (runtime.controllerForBatch(queued.batchId).signal.aborted) {
      STARTING_RUNS.delete(queued.runId)
      return
    }
    if (!execution || !host) {
      STARTING_RUNS.delete(queued.runId)
      await runtime.markEnd(queued.runId, { ok: false, error: host ? 'prompt unavailable after restart' : 'configured host is missing' })
      return
    }
    let started, controller, runPromise
    try {
      started = await runtime.markStart(queued.runId, { startedAt: Date.now(), timeoutMs: queued.timeoutMs || cfg().taskTimeoutMs })
      if (TERMINAL_RUN_STATUSES.has(started.status)) return
      if (host.kind === 'remote') await power?.markDispatchStarted?.(host.name)
      const current = runtime.getRun(queued.runId)
      controller = runtime.controllerForRun(queued.runId)
      // markDispatchStarted awaits the shared host power lock. Cancellation can
      // win during that wait, so re-read durable state and signal immediately
      // before the synchronous spawn continuation.
      if (!current || TERMINAL_RUN_STATUSES.has(current.status)) return
      if (controller.signal.aborted) {
        // Cancellation may win after markStart but before there is any runner.
        // No process needs cleanup in this window, so settle the pending intent.
        if (String(controller.signal.reason) === 'TIMEOUT') await runtime.markEnd(queued.runId, { ok: false, error: 'TIMEOUT' })
        else await runtime.confirmRemoteCancelled(queued.runId, current.cancelReason || '已取消（未启动）')
        return
      }
      publishExecution(current, 'running')
      LIVE_RUNS.add(queued.runId)
      try {
        runPromise = runOnHost(host, execution.prompt, controller.signal, execution.exec, {
          runId: queued.runId,
          runDir: queued.runDir,
          timeoutMs: queued.timeoutMs || cfg().taskTimeoutMs,
        })
      } catch (error) {
        LIVE_RUNS.delete(queued.runId)
        throw error
      }
    } finally {
      STARTING_RUNS.delete(queued.runId)
    }
    let result
    try {
      result = await runPromise
    } catch (error) {
      result = { ok: false, text: '', error: scrubSecrets(error?.message ?? error), host: host.name }
    } finally {
      LIVE_RUNS.delete(queued.runId)
    }
    if (result.cancelled) await runtime.confirmRemoteCancelled(queued.runId, runtime.getRun(queued.runId)?.cancelReason || '已取消')
    else if (result.detached) await runtime.markDetached(queued.runId, result.error)
    else if (!TERMINAL_RUN_STATUSES.has(runtime.getRun(queued.runId)?.status)) {
      await runtime.markEnd(queued.runId, {
        ok: result.ok === true,
        exit: result.exit,
        ms: result.ms,
        resultText: result.text,
        error: result.ok ? undefined : result.error,
      })
    }
    const settled = runtime.getRun(queued.runId)
    settleExecution(settled)
    if (settled && TERMINAL_RUN_STATUSES.has(settled.status)) {
      if (hostByName(settled.host)?.kind === 'remote') {
        try { await power?.markIdleSleepEligible?.(settled.host, { batchId: settled.batchId }) } catch {}
      }
    }
  }

  const queuePump = () => {
    if (pumpPromise) { pumpAgain = true; return pumpPromise }
    pumpPromise = (async () => {
      do {
        pumpAgain = false
        if (!runtime || shuttingDown) break
        for (const run of runtime.listRuns()) settleExecution(run)
        for (const run of runtime.listRuns().filter((candidate) => candidate.status === 'waking')) waitForWakingRun(run)
        while (runtime.activeCount() + STARTING_RUNS.size < Math.max(1, Number(cfg().globalMaxConcurrency) || 8)) {
          const queued = runtime.listRuns().find((candidate) => candidate.status === 'queued' &&
            !runtime.controllerForBatch(candidate.batchId).signal.aborted &&
            EXECUTIONS.has(candidate.runId) && !STARTING_RUNS.has(candidate.runId) && (() => {
              const host = hostByName(candidate.host)
              const startingOnHost = [...STARTING_RUNS.values()].filter((name) => name === candidate.host).length
              return host && hostInflight(host.name) + startingOnHost < Math.max(1, Number(host.maxConcurrency) || 3)
            })())
          if (!queued) break
          STARTING_RUNS.set(queued.runId, queued.host)
          const settlement = executeRegisteredRun(queued).catch(async (error) => {
            STARTING_RUNS.delete(queued.runId)
            const current = runtime.getRun(queued.runId)
            if (current && !TERMINAL_RUN_STATUSES.has(current.status)) {
              await runtime.markEnd(queued.runId, { ok: false, error: scrubSecrets(error?.message ?? error) })
            }
          }).finally(() => {
            LOCAL_SETTLEMENTS.delete(queued.runId)
            queuePump()
          })
          if (['local', 'codex'].includes(hostByName(queued.host)?.kind)) LOCAL_SETTLEMENTS.set(queued.runId, settlement)
          void settlement
        }
      } while (pumpAgain)
    })().finally(() => { pumpPromise = null; if (pumpAgain) queuePump() })
    return pumpPromise
  }

  const scheduleAcross = async (tasks, chosenHosts, exec, publish, signal = exec.signal, options = {}) => {
    await runtimeReady
    const results = new Array(tasks.length)
    const rows = tasks.map((task, index) => ({
      index: index + 1, item: task.item ?? null, type: null, provider: null,
      model: null, status: 'queued', host: null,
    }))
    const assignments = chooseAssignments(chosenHosts, tasks.length)
    const batchId = options.batchId || `b-${randomUUID()}`
    const label = options.label || `fleet ×${tasks.length}`
    const createdAt = Date.now()
    const records = tasks.map((task, index) => {
      const host = assignments[index]
      const runId = newRunId()
      rows[index] = { ...rows[index], host: host.name, provider: host.name, model: host.model || null }
      return {
        batchId, runId, index: index + 1, host: host.name,
        kind: host.kind,
        runDir: host.kind === 'local' ? '' : runDirOf(host, runId),
        model: host.model || '', origin: options.origin || 'tool', label,
        item: task.prompt, prompt: task.prompt, status: 'queued', at: createdAt,
        timeoutMs: options.timeoutMs || cfg().taskTimeoutMs,
        pinned: true, tag: '', wake: false,
      }
    })
    await runtime.registerDispatchBatch(records)
    const waits = records.map((record, index) => new Promise((resolve) => {
      EXECUTIONS.set(record.runId, { ...record, prompt: tasks[index].prompt, exec, publish, rows, index, resolve })
    }).then((result) => { results[index] = result }))
    publish(rows)
    const onAbort = () => { void runtime.cancelBatch(batchId, '已取消').finally(() => queuePump()) }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    runtime.wakePump('tool-dispatch:' + batchId)
    queuePump()
    try { await Promise.all(waits) } finally { signal?.removeEventListener?.('abort', onAbort) }
    return { batchId, results, rows }
  }

  const renderXml = (goal, tasks, results, chosenHosts) => {
    goal = scrubSecrets(goal)
    results = results.map((result) => scrubSecrets(result))
    const done = results.filter((r) => r && r.ok).length
    const lines = ['<agent_swarm_result>', '<summary>fleet: ' + done + '/' + tasks.length + ' done · ' + chosenHosts.map((h) => h.name).join(',') + '</summary>']
    for (let i = 0; i < tasks.length; i++) {
      const r = results[i] || { ok: false, error: 'not started', ms: 0, host: '' }
      lines.push('<subagent item="' + escapeXml(tasks[i].item || ('#' + (i + 1))) + '" model="' + escapeXml(r.host || '') + '"' + (r.ms ? ' ms="' + Math.round(r.ms) + '"' : '') + ' state="started" outcome="' + (r.ok ? 'completed' : 'failed') + '">' + escapeXml(clip(r.ok ? r.text : r.error, 12000)) + '</subagent>')
    }
    lines.push('<fleet goal="' + escapeXml(clip(goal, 200)) + '" hosts="' + escapeXml(chosenHosts.map((h) => h.name + (h.model ? '/' + h.model : '')).join(' ')) + '" done="' + done + '" total="' + tasks.length + '"/>')
    lines.push('</agent_swarm_result>')
    return lines.join('\n')
  }

  // ── fleet_run ────────────────────────────────────────────────────────────
  reg(defineTool({
    name: 'fleet_run',
    description: '把若干**自包含**子任务派到 fleet host 并行执行。默认只用 remote DSH worker；Codex SDK 必须显式 hosts:[codex] 或 tag:codex。适合工具重/需隔离的批量任务；任务必须自包含，产出以文本或工作区文件交回。',
    parameters: {
      items: { type: 'array', required: true, items: { type: 'string' }, description: '每项一个自包含子任务的完整指令(worker 直接把它当 prompt 跑)' },
      hosts: { type: 'array', items: { type: 'string' }, description: '只用这些机(名字);省略=所有健康的机' },
      tag: { type: 'string', description: '只用带此标签的机(如 tool-heavy),可选' },
      include_local: { type: 'boolean', description: '是否把本机(进程内子代理)也算作一台机,默认 false(留本机给主对话)' },
    },
    output: {
      schema: { type: 'string' },
      render: (_a, v) => [{ type: 'text', text: v }],
      presentationMeta: (args, value) => ({
        description: 'fleet · ' + (Array.isArray(args.items) ? args.items.length : 0) + ' 项',
        xml: value, assessment: null, fleet: parseFleetXml(value),
        subagents: parseResultsXml(value).map((r) => ({
          index: r.task.index, item: r.task.item ?? null, type: null, model: r.modelLabel ?? null,
          status: r.status, state: r.state ?? null, agentId: null, error: r.error ?? null, result: r.result ?? null,
          modelLabel: r.modelLabel ?? null, toolCalls: 0, toolList: null, elapsedMs: r.elapsedMs ?? 0, offsetMs: 0, alive: false, stopped: false,
        })),
      }),
    },
    timeoutMs: 3600000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      let items
      try {
        items = validateFleetItems(args.items)
      } catch (error) {
        if (error instanceof InputLimitError) throw new Error(error.message)
        throw error
      }
      const goal = clip(items.join(' | '), 200)
      const tasks = items.map((it, i) => ({ item: '#' + (i + 1), prompt: it }))
      // 宿主 Job Panel 是软依赖：服务缺席、start 抛错或没有 owner 时，仍走原执行路径。
      // cancel 与父 exec.signal 合并到同一个 controller，确保远端 pid kill、本地子代理 abort
      // 以及尚未发车的 pending 项吃到同一取消信号。
      let jobsSvc = null, jobId = null, jobResolve = null, jobAbort = null, forwardParentAbort = null
      if (exec.agent) {
        try {
          jobsSvc = ctx.get('jobs')
          if (jobsSvc && typeof jobsSvc.start === 'function') {
            jobAbort = new AbortController()
            if (exec.signal) {
              if (exec.signal.aborted) jobAbort.abort(exec.signal.reason)
              else {
                forwardParentAbort = () => jobAbort.abort(exec.signal.reason)
                exec.signal.addEventListener('abort', forwardParentAbort, { once: true })
              }
            }
            jobId = jobsSvc.start({
              kind: 'subagent',
              label: ('fleet ×' + tasks.length + ' · ' + goal).slice(0, 120),
              owner: exec.agent,
              run: () => ({
                cancel: () => { try { jobAbort.abort() } catch {} },
                done: new Promise((resolve) => { jobResolve = resolve }),
              }),
            })
          }
        } catch {
          if (forwardParentAbort) exec.signal?.removeEventListener?.('abort', forwardParentAbort)
          jobsSvc = null; jobId = null; jobResolve = null; jobAbort = null
        }
      }
      const batchSignal = jobAbort?.signal ?? exec.signal
      let results = []
      let runError = null
      try {
        await probeAll()
        let hs = hostsOf().filter((h) => HEALTH.get(h.name)?.ok)
        const explicitlyNamed = new Set(Array.isArray(args.hosts) ? args.hosts.map(String) : [])
        const codexOptIn = String(args.tag || '') === 'codex'
        hs = hs.filter((h) => h.kind !== 'codex' || codexOptIn || explicitlyNamed.has(h.name))
        if (args.include_local !== true) hs = hs.filter((h) => h.kind !== 'local')
        else if (!hs.some((h) => h.kind === 'local')) { const loc = hostsOf().find((h) => h.kind === 'local'); if (loc) { HEALTH.set(loc.name, { at: Date.now(), ok: true, version: 'in-process' }); hs.push(loc) } }
        if (Array.isArray(args.hosts) && args.hosts.length) hs = hs.filter((h) => args.hosts.includes(h.name))
        if (args.tag) hs = hs.filter((h) => (h.tags || []).includes(String(args.tag)))
        if (!hs.length) throw new Error(scrubSecrets('没有可用的机(预检:' + [...HEALTH.entries()].map(([n, v]) => n + '=' + (v.ok ? 'ok' : (v.error || 'down'))).join(', ') + ')'))
        const parentSessionId = exec.agent?.session?.id ?? exec.agent?.id
        // 进度发布是**跨插件**集成:写的是 swarm 模块级的 PROGRESS,由 swarm 自己的
        // /api/swarm/progress 路由喂前端(frontend/src/stores/live.ts:689 消费 calls)。
        // 真实宿主上 swarm 是同级插件,必然解析得到,行为与拆解前一致;干净依赖树里
        // 解析不到就**显式**警告一次,而不是静默丢进虚空 —— 见 fleet-swarm-compat.mjs。
        const progress = await resolveProgressPublisher()
        if (!progress.available && !PROGRESS_UNAVAILABLE_WARNED) {
          PROGRESS_UNAVAILABLE_WARNED = true
          console.warn('[fleet] 批次进度不会发布到 /api/swarm/progress:' + progress.reason)
        }
        const publish = (rows) => progress.publish(exec.callId, rows, parentSessionId)
        ;({ results } = await scheduleAcross(tasks, hs, exec, publish, batchSignal, {
          origin: 'tool',
          label: ('fleet ×' + tasks.length + ' · ' + goal).slice(0, 120),
        }))
        const xml = renderXml(goal, tasks, results, hs)
        const md = '\n\n**【Fleet】** ' + results.filter((r) => r && r.ok).length + '/' + tasks.length + ' 完成 · 机:' + hs.map((h) => h.name).join('/') +
          '\n\n' + results.map((r, i) => '- ' + tasks[i].item + '(' + (r?.host || '?') + '·' + (r ? Math.round(r.ms / 1000) + 's' : '-') + '):' + (r?.ok ? clip(r.text, 240) : '❌ ' + clip(r?.error, 160))).join('\n')
        return xml + md
      } catch (error) {
        runError = error
        throw error
      } finally {
        // 与 swarm batch 同语义：工具返回本身已经报告结果，先 wait 承诺报告，
        // resolve done 后再 read 标记 reported，避免宿主另开一轮完成通知。
        if (jobResolve && jobId !== null) {
          try {
            const doneN = results.filter((r) => r?.ok).length
            const observedFailedN = results.filter((r) => r && !r.ok).length
            // 预检/选机等异常可能发生在调度器产出任何 result 之前。此时未结算项
            // 也属于这次失败，不能把 failed job 显示成“0/N 完成、0 失败”。
            const failedN = runError
              ? Math.max(observedFailedN, tasks.length - doneN)
              : observedFailedN
            try { Promise.resolve(jobsSvc.wait?.(jobId, 5000, exec.agent)).catch(() => {}) } catch {}
            jobResolve({
              status: batchSignal?.aborted ? 'killed' : (runError || failedN ? 'failed' : 'completed'),
              detail: doneN + '/' + tasks.length + ' 完成' + (failedN ? ' · ' + failedN + ' 失败' : ''),
            })
            setTimeout(() => { try { jobsSvc.read?.(jobId, exec.agent) } catch {} }, 0)
          } catch {}
        }
        if (forwardParentAbort) exec.signal?.removeEventListener?.('abort', forwardParentAbort)
      }
    },
  }))

  // ── fleet_hosts ────────────────────────────────────────────────────────
  reg(defineTool({
    name: 'fleet_hosts',
    description: '列出 fleet 的机器、标签、默认模型、并发上限与实时健康(ssh 通不通、dsh 版本)。',
    parameters: {},
    output: {
      schema: { type: 'object', properties: { hosts: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } } }, additionalProperties: true },
      render: (a, v) => [{ type: 'text', text: '| 机 | 类型 | 模型 | 标签 | 并发 | 健康 |\n|---|---|---|---|---|---|\n' + v.hosts.map((h) => '| ' + h.name + ' | ' + h.kind + ' | ' + (h.model || '默认') + ' | ' + (h.tags || []).join(',') + ' | ' + h.maxConcurrency + ' | ' + (h.ok ? '✓ ' + (h.version || '') : '✗ ' + (h.error || '未探测')) + ' |').join('\n') }],
    },
    timeoutMs: 30000,
    isConcurrencySafe: () => true,
    async execute() {
      await probeAll()
      const rows = hostsOf().map((h) => {
        const base = { ...h, ...(HEALTH.get(h.name) || {}) }
        if (h.kind === 'remote' && base.ok) base.workspaceDir = wsOf(h)
        return base
      })
      return { hosts: scrubSecrets(rows) }
    },
  }))

  // ── 工作区检查(虚拟电脑)───────────────────────────────────────────────
  // 每台机的 ~/dsh-workspace 就是它的"电脑"—— 文件跨任务留存。这两个动作让你/agent 能看/取里面的东西。
  const wsOf = (h) => h.kind === 'codex'
    ? codexRunner.workspaceOf(h, DEFAULT_CODEX_WORKSPACE)
    : String(h.workspace || cfg().workspace || '~/dsh-workspace')
  const runDirOf = (host, runId) => host.kind === 'codex'
    ? codexRunner.runDirOf(host, runId, DEFAULT_CODEX_WORKSPACE)
    : `${wsOf(host).replace(/\/$/, '')}/tasks/${runId}`
  // ⚠️ 安全(审计 2026-08-20):fleet_ws read 与 /api/fleet/ws?path= 原来只拦 `..` 和单引号,**不拦绝对路径**——
  //   `cd ws && cat -- '/etc/passwd'` 直接读 worker 任意文件(~/.ssh、凭据 env…),而该工具暴露给模型调用。
  //   这里统一成一道闸:只接受工作区内的相对路径。返回规范化后的相对路径,非法返回 null。
  const safeRelPath = (raw) => {
    const p = String(raw ?? '').trim()
    if (!p) return null
    if (/[\0\r\n]/.test(p)) return null                 // 控制字符 / 换行:shell 注入面
    if (p.startsWith('/') || p.startsWith('~')) return null   // 绝对路径 / 家目录展开
    if (/^[A-Za-z]:[\\/]/.test(p)) return null          // 盘符(万一是 Windows worker)
    const parts = p.split('/').filter((s) => s !== '' && s !== '.')
    if (parts.some((s) => s === '..')) return null       // 逐段判 ..,不是 includes('..')(会误伤 "a..b")
    if (parts.length === 0) return null
    return parts.join('/')
  }
  // shell 单引号包裹:把路径里的 ' 转成 '\'' ,比 replace 掉更忠实也更安全
  const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'"
  // Quoting a whole `~/...` makes ~ literal; expanding it locally points at the
  // controller. Concatenate remote $HOME with a safely quoted tail instead.
  const remoteShellPath = (raw) => {
    const path = String(raw || '')
    if (path === '~') return '"$HOME"'
    if (path.startsWith('~/')) return '"$HOME"/' + shq(path.slice(2))
    return shq(path)
  }
  // ── POSIX 文件列表(审计 2026-08-20)──
  // 原来三处都用 GNU-only `find -printf`:macOS worker(agent-m4/knowledge-m4)的 BSD find 报 "unknown primary",
  // 错误被 2>/dev/null 吞 → 电脑视图工作区恒空、轨迹恒 NONE;而 `… | head || ls -laR` 的回退是死代码(管道退出码是 head 的)。
  // 改成 find 只负责找文件名,尺寸/mtime 用 stat 双试:GNU `stat -c` 失败就换 BSD `stat -f`,用 if/else 而非 ||。
  // 输出固定为 TSV:<mtime_epoch>\t<size>\t<path>。
  //   cwd: 要 cd 进去的目录(不加引号,让 ~ 展开);excludeTrace: 排除 .trace 内部;maxDepth: find 深度;limit: 行数上限
  const posixList = ({ cwd, root = '.', maxDepth = 3, excludeTrace = true, limit = 200, namePattern = null }) => {
    const ex = excludeTrace ? " -not -path '*/.trace/*'" : ''
    const nm = namePattern ? ' -name ' + shq(namePattern) : ''
    return 'cd ' + cwd + ' 2>/dev/null || exit 0; ' +
      `find ${root === '.' ? '.' : shq(root)} -maxdepth ${maxDepth} -type f${ex}${nm} 2>/dev/null | head -${limit} | while IFS= read -r f; do ` +
      `if s=$(stat -c '%Y\t%s' "$f" 2>/dev/null); then printf '%s\t%s\n' "$s" "$f"; ` +
      `elif s=$(stat -f '%m\t%z' "$f" 2>/dev/null); then printf '%s\t%s\n' "$s" "$f"; ` +
      `else printf '0\t0\t%s\n' "$f"; fi; done`
  }
  const parseList = (out) => String(out || '').trim().split('\n').filter(Boolean).map((l) => {
    const [mt, sz, ...rest] = l.split('\t'); const p = rest.join('\t')
    return { path: p.replace(/^\.\//, ''), size: Number(sz) || 0, mtime: Number(mt) || 0 }
  }).filter((f) => f.path)
  const sshRead = (host, shellCmd, timeoutMs = 20000, options = {}) => new Promise((resolve) => {
    if (host.kind !== 'remote') { resolve({ ok: false, out: '', err: '该 host 不使用 ssh' }); return }
    const child = spawn('ssh', [...sshOptions(8), host.ssh, 'export PATH="$HOME/.npm-global/bin:$PATH"; ' + shellCmd], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = '', settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(t)
      options.signal?.removeEventListener?.('abort', onAbort)
      resolve(value)
    }
    const onAbort = () => { try { child.kill('SIGKILL') } catch {}; finish({ ok: false, out: '', err: 'aborted', aborted: true }) }
    const t = setTimeout(() => { try { child.kill('SIGKILL') } catch {}; finish({ ok: false, out, err: err || 'ssh timeout', code: 124 }) }, timeoutMs)
    if (options.signal) {
      if (options.signal.aborted) { onAbort(); return }
      options.signal.addEventListener('abort', onAbort, { once: true })
    }
    child.stdout.on('data', (d) => { out += d }); child.stderr.on('data', (d) => { err += d })
    child.on('error', (e) => finish({ ok: false, out: '', err: String(e?.message ?? e) }))
    child.on('close', (code) => finish({ ok: code === 0, out, err: err.trim(), code }))
  })
  const probeRemoteRun = (host, run) => sshRead(host,
    `cd ${remoteShellPath(run.runDir)} 2>/dev/null || { echo MISSING; exit 0; }; if [ -f exit ]; then echo "SETTLED $(cat exit)"; exit 0; fi; p=$(cat pid 2>/dev/null); if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then echo "ALIVE $p"; else echo DEAD; fi`,
    15000)

  const spawnSsh = (host, shellCmd) => spawn('ssh', [
    ...sshOptions(cfg().sshConnectTimeoutSec),
    '-o', 'ServerAliveInterval=30',
    host.ssh,
    'export PATH="$HOME/.npm-global/bin:$PATH"; ' + shellCmd,
  ], { stdio: ['ignore', 'pipe', 'pipe'] })

  const runSmoke = (hostName, { signal } = {}) => new Promise((resolve) => {
    const host = hostByName(hostName)
    if (!host || host.kind !== 'remote') { resolve({ ok: false, error: 'no such remote host' }); return }
    const env = String(cfg().envFile || '~/.config/cc-model-secrets.env')
    const command = `export PATH="$HOME/.npm-global/bin:$PATH"; if [ -r ${env} ]; then . ${env} 2>/dev/null; fi; dsh --profile headless "$(cat)"`
    const child = spawn('ssh', [...sshOptions(8), host.ssh, command], { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = '', err = '', settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      resolve(scrubSecrets(value))
    }
    const onAbort = () => { try { child.kill('SIGKILL') } catch {}; finish({ ok: false, error: 'aborted' }) }
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch {}; finish({ ok: false, error: 'preflight timeout' }) }, 120000)
    if (signal) {
      if (signal.aborted) { onAbort(); return }
      signal.addEventListener('abort', onAbort, { once: true })
    }
    child.stdout.on('data', (chunk) => { if (out.length < 12000) out += String(chunk).slice(0, 12000 - out.length) })
    child.stderr.on('data', (chunk) => { if (err.length < 2000) err += String(chunk).slice(0, 2000 - err.length) })
    child.on('error', (error) => finish({ ok: false, error: error?.message ?? error }))
    child.on('close', (code) => {
      const text = out.trim()
      const failed = code !== 0 || !text || /MISSING_CREDENTIAL|\berror\b/i.test(text + '\n' + err)
      finish(failed ? { ok: false, error: err.trim() || text || `exit ${code}` } : { ok: true, text })
    })
    child.stdin.end('只回复一个字:好')
  })

  // Offline route/tool tests already redirect the SSH state directory. Keep
  // their ledger beside that fixture (one file per apply) so tests can never
  // populate the production runs.jsonl.
  const ledgerPath = process.env.DSH_FLEET_LEDGER_PATH ||
    (process.env.DSH_FLEET_SSH_STATE_DIR ? join(sshStateDir, `runs-${randomUUID()}.jsonl`) : undefined)
  const ledger = createFleetLedger({ ...(ledgerPath ? { path: ledgerPath } : {}), logger: { warn() {} } })
  runtimeReady = (async () => {
    const restoredEvents = await ledger.load()
    runtime = createFleetRuntime({
      ledger,
      probeRun: async (run) => {
        const host = hostByName(run.host)
        if (!host) return { ok: false, error: 'configured host is missing' }
        // A local in-process subagent cannot survive plugin/process restart.
        // Treat its durable orphan as lost instead of detached, which would
        // otherwise reserve a global slot forever with no remote pid to probe.
        if (host.kind === 'local') {
          return probeLocalRun({
            run,
            liveSet: LIVE_RUNS,
            controllerLookup: () => STARTING_RUNS.has(run.runId),
          })
        }
        if (host.kind === 'codex') return { ok: true, out: LIVE_RUNS.has(run.runId) ? 'ALIVE' : 'MISSING' }
        return probeRemoteRun(host, run)
      },
      readOutput: async (run, maxBytes) => {
        const host = hostByName(run.host)
        if (!host) return { ok: false, error: 'configured host is missing' }
        if (host.kind === 'codex') {
          try {
            const value = await readFile(join(run.runDir, 'out.txt'))
            return { ok: true, out: value.subarray(0, Math.min(200000, Math.max(1, Number(maxBytes) || 200000))).toString('utf8') }
          } catch (error) { return { ok: false, error: scrubSecrets(error?.message ?? error) } }
        }
        return sshRead(host, `cd ${remoteShellPath(run.runDir)} 2>/dev/null && head -c ${Math.min(200000, Math.max(1, Number(maxBytes) || 200000))} out.txt`, 20000)
      },
      onTimeout: async (run) => {
        const host = hostByName(run.host)
        if (!host) return { settled: false, state: 'detached', reason: 'configured host is missing' }
        if (host.kind === 'codex') {
          try { runtime.controllerForRun(run.runId).abort('TIMEOUT') } catch {}
          return { settled: false, state: 'detached', reason: 'Codex timeout cancellation pending' }
        }
        const killed = await remoteKill(host, run.runDir)
        return killed.ok
          ? { settled: true, exit: 143 }
          : { settled: false, state: 'detached', reason: 'timeout remote kill failed' }
      },
      cancelRemote: async (run) => {
        const host = hostByName(run.host)
        if (!host) return { ok: false, error: 'configured host is missing' }
        if (host.kind !== 'remote') return { ok: false, error: 'host has no remote process' }
        return remoteKill(host, run.runDir)
      },
      isLocalRun: (run) => hostByName(run.host)?.kind === 'local',
      isLocalExecution: (run) => hostByName(run.host)?.kind === 'local' || STARTING_RUNS.has(run.runId),
      hasLiveController: (run) => LIVE_RUNS.has(run.runId),
      clearControlSockets: async () => {
        let entries = []
        try { entries = readdirSync(sshStateDir, { withFileTypes: true }) } catch {}
        for (const entry of entries) {
          if (!/^cm-[A-Fa-f0-9]+$/.test(entry.name) || !entry.isSocket()) continue
          try { unlinkSync(join(sshStateDir, entry.name)) } catch {}
        }
      },
    })
    power = createFleetPower({
      powerNodes: cfg().powerNodes,
      wakeGateway: cfg().wakeGateway,
      wakeCommand: cfg().wakeCommand,
      wakeBudgetMs: cfg().wakeBudgetMs,
      wakePollMs: cfg().wakePollMs,
      sleepCommand: cfg().sleepCommand,
      sleepAllowedHosts: cfg().sleepAllowedHosts,
      probeHost: async (hostName) => {
        const host = hostByName(hostName)
        return host ? probeOne(host, { refresh: true }) : { ok: false, error: 'no such host' }
      },
      runSmoke,
      appendLedger: (event) => ledger.append(event),
      // Power safety counts every durable non-terminal reservation, not only
      // physical running/detached work. STARTING_RUNS explicitly covers the
      // markStart durability window until markDispatchStarted owns the host lock.
      getInflight: (hostName) => hostPowerReservations(hostName),
      sshArgs: sshOptions(8),
      restoredEvents,
    })
    await runtime.hydrate()
    await runtime.reconcileOnce()
    runtime.subscribeActivity(({ run }) => {
      settleExecution(run)
      if (run && TERMINAL_RUN_STATUSES.has(run.status) && hostByName(run.host)?.kind === 'remote') {
        void power.markIdleSleepEligible(run.host, { batchId: run.batchId }).catch(() => {})
      }
      queuePump()
    })
    runtime.subscribePump(() => queuePump())
    runtime.startReconciler()
    queuePump()
  })()

  const dispatchRuntime = {
    maxConcurrency: () => Math.max(1, Number(cfg().globalMaxConcurrency) || 8),
    activeCount: () => runtime?.activeCount?.() || 0,
    hostInflight: (hostName) => hostInflight(hostName),
    listRuns: (...args) => runtime.listRuns(...args),
    listBatches: (...args) => runtime.listBatches(...args),
    getBatch: (...args) => runtime.getBatch(...args),
    getRun: (...args) => runtime.getRun(...args),
    registerDispatchBatch: async (records) => {
      const runs = await runtime.registerDispatchBatch(records)
      for (let index = 0; index < records.length; index++) {
        const record = records[index]
        EXECUTIONS.set(record.runId, {
          ...record,
          prompt: record.item ?? record.prompt,
          exec: { agent: undefined, signal: runtime.controllerForRun(record.runId).signal, callId: record.batchId },
          index,
        })
      }
      return runs
    },
    markQueued: (...args) => runtime.markQueued(...args),
    rerouteRun: (...args) => runtime.rerouteRun(...args),
    markEnd: (...args) => runtime.markEnd(...args),
    cancelRun: async (...args) => {
      const value = await runtime.cancelRun(...args)
      for (const run of runtime.listRuns()) settleExecution(run)
      queuePump()
      return value
    },
    cancelBatch: async (...args) => {
      const value = await runtime.cancelBatch(...args)
      for (const run of runtime.listRuns()) settleExecution(run)
      queuePump()
      return value
    },
    wakePump: (...args) => runtime.wakePump(...args),
  }

  const powerAdapter = {
    canWake: (hostName) => hostByName(hostName)?.kind === 'remote' && power?.canWake(hostName) === true,
    state: (hostName) => power?.state(hostName),
    request: (...args) => power.request(...args),
  }

  const probeCandidates = async (candidates, { refresh = false } = {}) => {
    const result = new Map()
    await Promise.all(candidates.map(async (host) => {
      const health = await probeOne(host, { refresh })
      result.set(host.name, health)
      if (host.kind === 'remote') power?.setReachability(host.name, health)
    }))
    return result
  }
  const wsFileCount = async (h) => {
    const r = await sshRead(h, 'ls -1 ' + wsOf(h) + ' 2>/dev/null | wc -l', 12000)
    return r.ok ? Number(r.out.trim()) || 0 : null
  }
  reg(defineTool({
    name: 'fleet_ws',
    description: '看/取某台 fleet 机器的"虚拟电脑"工作区(~/dsh-workspace):list 列文件树,read 读某个文件。fleet 任务都在这个工作区里跑,产出留在这里。',
    parameters: {
      host: { type: 'string', required: true, description: '机器名(见 fleet_hosts)' },
      action: { type: 'string', enum: ['list', 'read'], description: 'list(默认)列文件;read 读文件' },
      path: { type: 'string', description: 'read 时:相对工作区的文件路径' },
    },
    output: {
      schema: { type: 'object', properties: { host: { type: 'string', required: true }, listing: { type: 'string' }, content: { type: 'string' }, error: { type: 'string' } }, additionalProperties: true },
      render: (a, v) => [{ type: 'text', text: v.error ? ('⚠️ ' + v.error) : (a.action === 'read' ? ('```\n' + (v.content || '(空)') + '\n```') : ('**' + v.host + '** 工作区:\n```\n' + (v.listing || '(空)') + '\n```')) }],
    },
    timeoutMs: 30000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const h = hostsOf().find((x) => x.name === String(args.host))
      if (!h) return { host: String(args.host), error: '没有这台机:' + args.host }
      if (h.kind === 'local') return { host: h.name, error: '本机(local)没有远端工作区' }
      if (h.kind === 'codex') return { host: h.name, error: 'Codex 工作区按 run 隔离，请从批次的产物清单读取' }
      const ws = wsOf(h)
      if (args.action === 'read') {
        const p = safeRelPath(args.path)
        if (!p) return { host: h.name, error: 'read 只接受工作区内的相对路径(不能以 / 或 ~ 开头、不能含 ..):' + String(args.path || '') }
        // ⚠️ cat 不能单引号整条含 ~ 的路径(~ 不展开)。先 cd 到工作区(不引号 → ~ 展开),再 cat 相对路径。
        const r = await sshRead(h, 'cd ' + ws + ' 2>/dev/null && cat -- ' + shq(p) + ' 2>&1 | head -c 20000', 20000)
        return scrubSecrets(r.ok ? { host: h.name, content: r.out } : { host: h.name, error: r.err || ('exit ' + r.code) })
      }
      const r = await sshRead(h, posixList({ cwd: ws, maxDepth: 4, limit: 80 }), 20000)
      const files = r.ok ? parseList(r.out) : []
      const listing = files.length ? files.map((f) => f.path + '  ' + f.size + '字节').join('\n') : '(工作区为空或不存在)'
      return scrubSecrets(r.ok ? { host: h.name, listing } : { host: h.name, error: r.err || ('exit ' + r.code) })
    },
  }))

  // ── 把远端机注册成子代理 provider(fleet:<host>)───────────────────────
  // 这样 swarm / civ 的调度器不必 import fleet,只要 `ctx.subagents.start('fleet:<host>', …)` 就能把
  // 某个 item 派到那台机跑;`ctx.subagents.list()` 里的 fleet:* 前缀条目 = 当前可派的机(免循环依赖)。
  const registerRemoteProviders = () => {
    const sub = ctx.subagents
    if (!sub || typeof sub.registerProvider !== 'function') return
    const existing = typeof sub.list === 'function' ? new Set(sub.list()) : new Set()
    for (const h of hostsOf()) {
      // swarm_auto 会自动枚举 fleet:* provider；Codex 必须保持 opt-in，不能
      // 通过这个旁路被默认 offload 消耗额度。
      if (h.kind !== 'remote') continue
      const pname = 'fleet:' + h.name
      if (existing.has(pname)) continue
      try {
        sub.registerProvider({
          name: pname,
          capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
          inheritsParentContext: false,
          start(request) {
            const prompt = (request.prompt || []).filter((b) => b && b.type === 'text').map((b) => b.text).join('\n')
            const id = 'fleet-' + h.name + '-' + randomUUID()
            const execution = { agent: undefined, signal: request.signal, callId: id }
            const result = scheduleAcross(
              [{ item: '#1', prompt }],
              [h],
              execution,
              () => {},
              request.signal,
              { origin: 'provider', label: ('fleet provider · ' + h.name).slice(0, 120) },
            ).then(({ results }) => results[0]).then((r) => ({
              output: [{ type: 'text', text: r.ok ? r.text : ('[' + h.name + ' 执行失败] ' + (r.error || '')) }],
              stopReason: r.ok ? 'completed' : 'error',
            }))
            return { id, localAgent: void 0, result, async dispose() {} }
          },
        })
      } catch (e) { /* 已注册/重复 → 忽略;provider 生命周期由 ctx 管 */ }
    }
  }
  registerRemoteProviders()

  // ── /fleet 命令 ──────────────────────────────────────────────────────────
  disposers.push(ctx.commands.register({
    name: 'fleet',
    description: 'run self-contained subtasks across homelab machines: /fleet <task1> ;; <task2> ;; …',
    input: { hint: '<task> ;; <task> ;; …' },
    handler: (invocation) => {
      const raw = invocation.rawInput.trim()
      if (!raw) return { kind: 'error', text: '用法:/fleet <任务1> ;; <任务2> ;; …(用 ;; 分隔多个自包含任务)' }
      const items = raw.split(';;').map((x) => x.trim()).filter(Boolean)
      invocation.agent.steer(createUserMessage({
        content: [{ type: 'text', text: '调用 fleet_run 工具,items 设为下面这' + items.length + '项(逐项原样,不要改写):\n' + JSON.stringify(items) + '\n\n工具返回后把各机结果逐条整理给我。' }],
        source: { kind: 'plugin', plugin: 'dsh-fleet' },
      }))
      return { kind: 'success', text: '已交给 fleet_run(' + items.length + ' 项,派到 homelab 机器并行)' }
    },
  }))

  if ((cfg().announceToAgent ?? true) === true) {
    disposers.push(ctx.systemPrompt.section({ name: 'plugin:dsh-fleet', order: SECTION_ORDER, text: GUIDANCE }))
  }

  const webFiber = ctx.inject(['webServer'], (c) => {
    const ws = c.get('webServer')
    if (!ws || typeof ws.register !== 'function') return () => {}
    const routeDisposers = []
    const send = (res, code, obj, headers = {}) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers })
      res.end(JSON.stringify(scrubSecrets(obj)))
    }
    const readyHandler = (handler) => async (req, res) => {
      try { await runtimeReady } catch (error) {
        send(res, 503, { error: 'fleet runtime unavailable', detail: error?.message ?? error })
        return
      }
      return handler(req, res)
    }
    const readyWebServer = {
      register(spec) { return ws.register({ ...spec, handler: readyHandler(spec.handler) }) },
    }
    routeDisposers.push(registerFleetDispatchRoutes(readyWebServer, {
      runtime: dispatchRuntime,
      hosts: hostsOf,
      probe: probeCandidates,
      wake: powerAdapter,
      scrubSecrets,
      runDirOf,
      logger: { warn() {} },
    }))

    const artifactHandlers = createArtifactHandlers({
      hostsOf,
      wsOf,
      sshRead,
      spawnSsh,
      scrubSecrets,
      onStreamError: (event) => { void ledger.append({ ev: 'artifact-error', ...event }).catch(() => {}) },
    })
    routeDisposers.push(ws.register({ kind: 'exact', path: '/api/fleet/artifacts', handler: artifactHandlers.manifestHandler }))
    routeDisposers.push(ws.register({ kind: 'prefix', path: '/fleet', handler: artifactHandlers.prefixHandler }))

    const readBody = async (req) => {
      if (String(req.headers?.['content-type'] || '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
        const error = new Error('content-type must be application/json'); error.statusCode = 415; throw error
      }
      const chunks = []; let bytes = 0
      for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        bytes += buffer.length
        if (bytes > 65536) { const error = new Error('body too large'); error.statusCode = 413; throw error }
        chunks.push(buffer)
      }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
      catch { const error = new Error('body must be valid JSON'); error.statusCode = 400; throw error }
    }
    const remoteTargets = (names) => {
      if (!Array.isArray(names) || !names.length || names.some((value) => typeof value !== 'string' || !value.trim())) {
        const error = new Error('hosts must be a non-empty string array'); error.statusCode = 400; throw error
      }
      const unique = [...new Set(names.map((value) => value.trim()))]
      const found = unique.map((hostName) => hostByName(hostName))
      if (found.some((host) => !host || host.kind !== 'remote')) {
        const error = new Error('one or more remote hosts do not exist'); error.statusCode = 404; throw error
      }
      return found
    }
    const powerRoute = (method, handler) => readyHandler(async (req, res) => {
      if (req.method !== method) { send(res, 405, { error: method + ' only' }, { allow: method }); return }
      try { await handler(req, res) }
      catch (error) { send(res, Number(error?.statusCode) || 500, { error: error?.message ?? error, code: error?.code }) }
    })
    routeDisposers.push(ws.register({
      kind: 'exact', path: '/api/fleet/power',
      handler: powerRoute('GET', async (_req, res) => {
        const names = hostsOf().filter((host) => host.kind === 'remote').map((host) => host.name)
        send(res, 200, { at: Date.now(), nodes: power.list(names) })
      }),
    }))
    routeDisposers.push(ws.register({
      kind: 'exact', path: '/api/fleet/wake',
      handler: powerRoute('POST', async (req, res) => {
        const targets = remoteTargets((await readBody(req))?.hosts)
        await probeCandidates(targets, { refresh: true })
        const summary = await power.request(targets.map((host) => host.name), { source: 'manual', pinned: false })
        send(res, 202, { ...summary, states: targets.map((host) => power.state(host.name)) })
      }),
    }))
    routeDisposers.push(ws.register({
      kind: 'exact', path: '/api/fleet/preflight',
      handler: powerRoute('POST', async (req, res) => {
        const targets = remoteTargets((await readBody(req))?.hosts)
        const rows = []
        for (const host of targets) {
          const probe = await power.probe(host.name)
          const smoke = probe.ok ? await power.runSmokeCheck(host.name, { force: true }) : { ok: false, skipped: true, error: probe.error }
          rows.push({ host: host.name, reachable: probe.ok === true, probe, smoke })
        }
        send(res, 200, { at: Date.now(), hosts: rows })
      }),
    }))
    routeDisposers.push(ws.register({
      kind: 'exact', path: '/api/fleet/sleep',
      handler: powerRoute('POST', async (req, res) => {
        const body = await readBody(req)
        const [host] = remoteTargets([body?.host])
        const result = await power.sleepHost(host.name, { confirm: body?.confirm })
        send(res, result.ok ? 200 : 502, result)
      }),
    }))
    routeDisposers.push(ws.register({
      kind: 'exact', path: '/api/fleet/hosts',
      handler: async (req, res) => {
        if (req.method !== 'GET') { send(res, 405, { error: 'GET only' }); return }
        try {
          await runtimeReady
          const u = new URL(req.url, 'http://x')
          const refresh = u.searchParams.get('refresh') === '1'
          const includeWorkspaceCount = u.searchParams.get('ws') === '1'
          await probeAll({ refresh })
          const rows = await Promise.all(hostsOf().map(async (h) => {
            const durableRuns = runtime.listRuns().filter((run) => run.host === h.name).slice(0, RUNS_KEEP)
            const current = durableRuns.find((run) => !TERMINAL_RUN_STATUSES.has(run.status))
            const base = {
              ...h,
              ...(HEALTH.get(h.name) || {}),
              inflight: hostInflight(h.name),
              currentTask: current?.prompt || null,
              runs: durableRuns,
              power: h.kind === 'remote' ? power.state(h.name) : undefined,
            }
            if ((h.kind === 'remote' || h.kind === 'codex') && base.ok) {
              base.workspaceDir = wsOf(h)
              if (includeWorkspaceCount && h.kind === 'remote') {
                try { base.wsFiles = await wsFileCount(h) } catch { base.wsFiles = null }
              }
            }
            return base
          }))
          send(res, 200, { hosts: rows })
        } catch (e) { send(res, 500, { error: String(e?.message ?? e) }) }
      },
    }))
    // 浏览某台机的"虚拟电脑"工作区:GET /api/fleet/ws?host=leo-01[&path=foo/bar.txt]
    routeDisposers.push(ws.register({
      kind: 'exact', path: '/api/fleet/ws',
      handler: async (req, res) => {
        if (req.method !== 'GET') { send(res, 405, { error: 'GET only' }); return }
        try {
          const u = new URL(req.url, 'http://x')
          const h = hostsOf().find((x) => x.name === u.searchParams.get('host'))
          if (!h) { send(res, 404, { error: 'no such host' }); return }
          if (h.kind !== 'remote') { send(res, 400, { error: h.kind === 'codex' ? 'codex workspace is available through run artifacts' : 'local has no remote workspace' }); return }
          const rawPath = u.searchParams.get('path') || ''
          const wsdir = wsOf(h)
          if (rawPath) {
            const runId = u.searchParams.get('run') || ''
            const path = safeArtifactRelPath(rawPath)
            if (!validateRunId(runId)) { send(res, 400, { error: 'run is required and must be a valid run id' }); return }
            if (!path) { send(res, 400, { error: 'path must be a safe artifact-relative path' }); return }
            // 单次远端执行:判决行先到,字节从同一个已校验的描述符出。
            //
            // 原先这里是两趟 SSH(probe 拿元数据、再读字节),而且第二趟被管进
            // `head -c 40000` —— 管道的退出码是 **head 的**,于是远端的拒绝
            // (exit 9)被吞掉,预览路径把「我拒绝给你」变成「成功读到一个空文件」的 200。
            // 实测(E 的 verify-index-patch.mjs,guard→open 之间做 hardlink 替换):
            // 旧写法 200 + 空体,新写法 409 artifact refused: hard-links。
            // 不泄漏 sentinel(字节那趟本来就绑描述符),但它**不诚实** —— 操作者
            // 分不清「产物是空的」和「产物被拒了」。limitBytes 在已持有的 fd 上截断
            // (`head -c N <&3`),是同一个对象的更小一次读,不是第二次解析名字。
            const target = { workspace: wsdir, runId, path }
            let command
            try { command = buildArtifactFileCommand({ ...target, protocol: true, limitBytes: 40000 }) }
            catch { send(res, 400, { error: 'invalid artifact path' }); return }
            const r = await sshRead(h, command, 20000)
            if (!r.ok) { send(res, 502, { error: r.err || ('ssh exit ' + r.code) }); return }
            const nl = r.out.indexOf('\n')
            const verdict = parseArtifactStreamStatus(nl === -1 ? '' : r.out.slice(0, nl))
            if (!verdict.ok) { send(res, verdict.status, { error: verdict.error }); return }
            send(res, 200, { host: h.name, runId, path, content: r.out.slice(nl + 1) })
          } else {
            // POSIX 列表(GNU/BSD stat 双试),排除 .trace 内部;深度 4 覆盖 tasks/<runId>/产物
            const r = await sshRead(h, posixList({ cwd: wsdir, maxDepth: 4, limit: 300 }), 20000)
            const files = r.ok ? parseList(r.out) : []
            // 也把 pid 文件藏掉(它是取消机制的内部文件)
            send(res, 200, { host: h.name, workspaceDir: wsdir, files: files.filter((f) => !/(^|\/)pid$/.test(f.path)) })
          }
        } catch (e) { send(res, 500, { error: String(e?.message ?? e) }) }
      },
    }))
    // 实时轨迹:GET /api/fleet/trace?host=X&run=R&from=1&max=2000。
    // 用物理行号增量读，不依赖会有空洞的 seq；首页因此始终包含 FoldedHeader 需要的 session 首行。
    routeDisposers.push(ws.register({
      kind: 'exact', path: '/api/fleet/trace',
      handler: async (req, res) => {
        if (req.method !== 'GET') { send(res, 405, { error: 'GET only' }); return }
        try {
          const u = new URL(req.url, 'http://x')
          const h = hostsOf().find((x) => x.name === u.searchParams.get('host'))
          if (!h) { send(res, 404, { error: 'no such host' }); return }
          if (h.kind !== 'remote') { send(res, 400, { error: h.kind === 'codex' ? 'codex runs do not expose DSH trace events' : 'local has no remote workspace' }); return }
          const rawRun = u.searchParams.get('run')
          if (rawRun !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(rawRun)) { send(res, 400, { error: 'invalid run id' }); return }
          const rawFrom = u.searchParams.get('from')
          const rawMax = u.searchParams.get('max')
          const from = rawFrom === null ? 1 : Number(rawFrom)
          const max = rawMax === null ? 2000 : Number(rawMax)
          if (!Number.isSafeInteger(from) || from < 1) { send(res, 400, { error: 'from must be a positive integer' }); return }
          if (!Number.isSafeInteger(max) || max < 1 || max > 2000) { send(res, 400, { error: 'max must be an integer from 1 to 2000' }); return }
          const wsdir = wsOf(h)
          // 审计(2026-08-20):原来按 mtime 取"最新那份 session.jsonl",同机并发时在多会话间来回抖动。
          // 现在每个 run 有独立 trace root(<ws>/tasks/<runId>/.trace),路由支持:
          //   ?run=<runId> 精确取该 run;不传则取最近一次 run(按 runs 目录 mtime);
          //   同时返回 runs 列表(runId + 有无 trace + mtime)让面板分 tab。全部 POSIX(find + stat 双试)。
          const wantRun = rawRun || ''
          // 1) 列出 tasks/*/.trace/**/session.jsonl(深度受限),输出 mtime\tsize\tpath
          const globalListCmd = posixList({ cwd: wsdir + '/tasks', maxDepth: 6, excludeTrace: false, limit: 200, namePattern: 'session.jsonl' })
          // runs tab 仍只列最多 200 份，但显式 run 必须额外定向扫描；否则旧 run 会被全局 head -200 误报为未落盘。
          const listCmd = wantRun
            ? posixList({ cwd: wsdir + '/tasks', root: './' + wantRun + '/.trace', maxDepth: 5, excludeTrace: false, limit: 200, namePattern: 'session.jsonl' }) + '; ' + globalListCmd
            : globalListCmd
          const lr = await sshRead(h, listCmd, 15000)
          if (!lr.ok) { send(res, 502, { error: lr.err || ('ssh exit ' + lr.code) }); return }
          const listed = [...new Map(parseList(lr.out).map((f) => [f.path, f])).values()]
          const traces = listed.map((f) => ({ ...f, runId: (f.path.match(/^([^/]+)\//) || [])[1] || null })).filter((f) => f.runId)
          traces.sort((a, b) => b.mtime - a.mtime)
          const runsSeen = [...new Map(traces.map((t) => [t.runId, { runId: t.runId, mtime: t.mtime, file: t.path }])).values()]
          const pick = wantRun ? traces.find((t) => t.runId === wantRun) : traces[0]
          if (!pick) { send(res, 200, { host: h.name, runId: wantRun || null, file: null, from, nextFrom: from, total: 0, truncated: false, lines: [], runs: runsSeen, notice: 'trace-not-created' }); return }
          const rel = pick.path
          const r = await sshRead(h, 'cd ' + wsdir + '/tasks 2>/dev/null || exit 0; f=' + shq(rel) + '; echo "TOTAL $(wc -l < "$f" 2>/dev/null || echo 0)"; tail -n +' + from + ' "$f" 2>/dev/null | head -' + max, 15000)
          if (!r.ok) { send(res, 502, { error: r.err || ('ssh exit ' + r.code) }); return }
          const raw = r.out.split('\n')
          let total = 0, body = raw
          if ((raw[0] || '').startsWith('TOTAL ')) { total = Number(raw[0].slice(6).trim()) || 0; body = raw.slice(1) }
          // ssh stdout 通常以换行结束；只去掉这个传输尾巴，内部空行仍占物理行号。
          if (body.length && body[body.length - 1] === '') body = body.slice(0, -1)
          const nextFrom = from + body.length
          // truncated 表示远程文件已轮转/截短，不是“本页后还有数据”；后者由 nextFrom <= total 即可判断。
          send(res, 200, { host: h.name, runId: pick.runId, file: rel, from, nextFrom, total, truncated: total < from - 1, lines: body, runs: runsSeen })
        } catch (e) { send(res, 500, { error: String(e?.message ?? e) }) }
      },
    }))
    return () => {
      for (const dispose of routeDisposers.splice(0).reverse()) {
        try { dispose?.() } catch {}
      }
    }
  })
  if (typeof webFiber === 'function') disposers.push(webFiber)

  return async () => {
    shuttingDown = true
    const drains = []
    for (const dispose of disposers.reverse()) {
      try {
        const value = dispose?.()
        if (value && typeof value.then === 'function') drains.push(value)
      } catch {}
    }
    await Promise.allSettled(drains)
    try { await runtimeReady } catch {}
    // Remote jobs intentionally survive plugin churn and reconcile later. A local
    // subagent or Codex SDK child cannot be reattached, so abort and await them
    // before the runtime/ledger handles are released.
    if (runtime) {
      const liveLocal = runtime.listRuns().filter((run) =>
        ['local', 'codex'].includes(hostByName(run.host)?.kind) && !TERMINAL_RUN_STATUSES.has(run.status))
      await Promise.allSettled(liveLocal.map((run) => runtime.cancelRun(run.runId, 'plugin disposed')))
      // The pump is stopped during shutdown; queued cancellations still need
      // their waiting tool promises resolved even though no active slot changed.
      for (const run of runtime.listRuns()) settleExecution(run)
      await Promise.allSettled(liveLocal.map((run) => LOCAL_SETTLEMENTS.get(run.runId)).filter(Boolean))
      // A pre-spawn cancellation can become terminal only while awaiting the
      // settlement above. Sweep again because the shutdown pump is disabled.
      for (const run of runtime.listRuns()) settleExecution(run)
    }
    try { await runtime?.shutdown?.() } catch {}
    try { await ledger.drain() } catch {}
  }
}

function parseFleetXml(xml) {
  const m = /<fleet ([^>]*)\/>/.exec(String(xml ?? ''))
  if (!m) return null
  const out = {}; const re = /(\w+)="([^"]*)"/g; let a
  while ((a = re.exec(m[1])) !== null) out[a[1]] = a[2].replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')
  return out
}

export { Config, apply, inject, name }
