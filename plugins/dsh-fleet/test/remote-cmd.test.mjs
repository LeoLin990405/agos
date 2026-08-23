// 纯离线：假 ssh 只记录 argv/消费 stdin，不会连接任何主机。
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmp = mkdtempSync(join(tmpdir(), 'dsh-fleet-remote-cmd-'))
const sshLog = join(tmp, 'ssh.log')
const sshState = join(tmp, 'ssh-state')
const remoteHome = join(tmp, 'remote-home')
const wrapperErr = join(tmp, 'wrapper.err')
const remoteCmdLog = join(tmp, 'remote-command.sh')
const workspaceDirName = 'work dir; touch PWNED; #'
const stubSsh = join(tmp, 'ssh')
mkdirSync(join(remoteHome, '.npm-global', 'bin'), { recursive: true })
mkdirSync(join(remoteHome, '.config'), { recursive: true })
writeFileSync(join(remoteHome, '.config', 'test.env'), 'export TEST_FLEET_ENV=loaded\n')
writeFileSync(join(remoteHome, '.npm-global', 'bin', 'dsh'), `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'dsh-test-1.0\\n'; exit 0; fi
last=''
for a in "$@"; do last="$a"; done
case "$last" in
  FAIL*)
    printf 'failure:' >&2
    i=0; while [ "$i" -lt 2100 ]; do printf 'E' >&2; i=$((i + 1)); done
    exit 23
    ;;
  *) printf 'persisted stdout:%s:%s\\n' "\${TEST_FLEET_ENV:-missing}" "$last" ;;
esac
`)
chmodSync(join(remoteHome, '.npm-global', 'bin', 'dsh'), 0o755)
writeFileSync(stubSsh, `#!/bin/sh
{
  printf 'CALL\\n'
  for a in "$@"; do
    case "$a" in *"command -v dsh"*|*"dsh --profile headless"*) ;; *) printf 'ARG:%s\\n' "$a" ;; esac
  done
} >> "$DSH_FLEET_SSH_LOG"
while [ "$#" -gt 0 ]; do
  case "$1" in -o) shift 2 ;; *) host="$1"; shift; break ;; esac
done
cmd="$1"
case "$cmd" in *"dsh --profile headless"*) printf '%s' "$cmd" > "$DSH_FLEET_REMOTE_CMD_LOG" ;; esac
case "$DSH_FLEET_REMOTE_SHELL" in
  bash) runner='/bin/bash --posix' ;;
  *) runner='/bin/dash' ;;
esac
: > "$DSH_FLEET_WRAPPER_ERR"
(cd "$DSH_FLEET_REMOTE_HOME" && HOME="$DSH_FLEET_REMOTE_HOME" $runner -c "$cmd") 2> "$DSH_FLEET_WRAPPER_ERR"
rc=$?
cat "$DSH_FLEET_WRAPPER_ERR" >&2
exit "$rc"
`)
chmodSync(stubSsh, 0o755)
process.env.PATH = tmp + ':' + process.env.PATH
process.env.DSH_FLEET_SSH_LOG = sshLog
process.env.DSH_FLEET_SSH_STATE_DIR = sshState
process.env.DSH_FLEET_REMOTE_HOME = remoteHome
process.env.DSH_FLEET_WRAPPER_ERR = wrapperErr
process.env.DSH_FLEET_REMOTE_CMD_LOG = remoteCmdLog

const { apply, Config } = await import('../lib/index.js')

const tools = new Map()
const ctx = {
  tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
  commands: { register: () => () => {} },
  systemPrompt: { section: () => () => {} },
  subagents: { start: async () => { throw new Error('not used') } },
  get: () => undefined,
  inject: () => {},
}
apply(ctx, Config({
  hosts: [{ name: 'fake', kind: 'remote', ssh: 'fake', model: 'fake', tags: ['test'], maxConcurrency: 1, enabled: true, workspace: '~/' + workspaceDirName }],
  envFile: '~/.config/test.env',
}))

const exec = { agent: { id: 'parent', session: { id: 'parent' } }, signal: new AbortController().signal, callId: 'call' }

function calls() {
  return readFileSync(sshLog, 'utf8').split('CALL\n').filter(Boolean).map((block) => block.trim().split('\n').map((line) => line.slice(4)))
}

function runDirs() {
  const tasks = join(remoteHome, workspaceDirName, 'tasks')
  try { return readdirSync(tasks).map((name) => join(tasks, name)) } catch { return [] }
}

test('remote command executes under dash, drains stdin, and persists successful state', async () => {
  process.env.DSH_FLEET_REMOTE_SHELL = 'dash'
  const xml = await tools.get('fleet_run').execute({ items: ['offline prompt'] }, exec)
  assert.match(xml, /outcome="completed"/)
  assert.match(xml, /persisted stdout:loaded:offline prompt/)

  const dirs = runDirs()
  assert.equal(dirs.length, 1)
  assert.equal(readFileSync(join(dirs[0], 'exit'), 'utf8'), '0')
  assert.equal(readFileSync(join(dirs[0], 'out.txt'), 'utf8'), 'persisted stdout:loaded:offline prompt\n')
  assert.equal(readFileSync(join(dirs[0], 'err.txt'), 'utf8'), '')
  assert.match(readFileSync(join(dirs[0], 'pid'), 'utf8'), /^\d+$/)
  assert.equal(statSync(join(dirs[0], '.trace')).isDirectory(), true)
  assert.equal(existsSync(join(remoteHome, 'PWNED')), false, 'quoted remote workspace must not execute injected shell text')

  const command = readFileSync(remoteCmdLog, 'utf8')
  const fragments = [
    "trap '' HUP",
    'p="$(cat)"',
    'dsh --profile headless --patch .trace/patch.yml "$p" >out.txt 2>err.txt </dev/null &',
    'w=$!',
    'printf %s "$w" > pid',
    'wait "$w"',
    'rc=$?',
    'printf %s "$rc" > exit',
    'cat out.txt',
    '[ "$rc" -eq 0 ] || head -c 2000 err.txt >&2',
    'exit "$rc"',
  ]
  let previous = -1
  for (const fragment of fragments) {
    const at = command.indexOf(fragment)
    assert.ok(at > previous, `missing or out-of-order remote fragment: ${fragment}`)
    previous = at
  }
  assert.ok(command.indexOf('p="$(cat)"') < command.indexOf(' </dev/null &'), 'stdin must be drained before backgrounding')
  assert.match(command, /"\$HOME"\/'work dir; touch PWNED; #\/tasks\/r-/)
})

test('remote command executes under bash POSIX mode and preserves failure surface', async () => {
  process.env.DSH_FLEET_REMOTE_SHELL = 'bash'
  const xml = await tools.get('fleet_run').execute({ items: ['FAIL offline prompt'] }, exec)
  assert.match(xml, /outcome="failed"/)

  const failed = runDirs().find((dir) => readFileSync(join(dir, 'exit'), 'utf8') === '23')
  assert.ok(failed, 'non-zero remote run was not persisted')
  assert.equal(readFileSync(join(failed, 'out.txt'), 'utf8'), '')
  assert.equal(readFileSync(join(failed, 'err.txt'), 'utf8').length, 'failure:'.length + 2100)
  assert.equal(readFileSync(wrapperErr).length, 2000, 'compatibility stderr must be capped at 2000 bytes')
  assert.equal(existsSync(join(remoteHome, 'PWNED')), false, 'bash-posix must receive the same non-injectable remote path')
})

test('all captured ssh calls use a secured 60-second control master', () => {
  const mode = statSync(sshState).mode & 0o777
  assert.equal(mode, 0o700)
  const expectedPath = 'ControlPath=' + join(sshState, 'cm-%C')
  for (const argv of calls()) {
    assert.ok(argv.includes('ControlMaster=auto'))
    assert.ok(argv.includes(expectedPath))
    assert.ok(argv.includes('ControlPersist=60'))
  }
})

test.after(() => {
  delete process.env.DSH_FLEET_SSH_LOG
  delete process.env.DSH_FLEET_SSH_STATE_DIR
  delete process.env.DSH_FLEET_REMOTE_HOME
  delete process.env.DSH_FLEET_REMOTE_SHELL
  delete process.env.DSH_FLEET_WRAPPER_ERR
  delete process.env.DSH_FLEET_REMOTE_CMD_LOG
  try { rmSync(tmp, { recursive: true, force: true }) } catch {}
})
