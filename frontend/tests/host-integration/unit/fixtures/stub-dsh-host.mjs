/**
 * A stand-in for the pinned `dsh` binary, used by the harness regressions.
 *
 * It is NOT a fake of the product under test — the product under test here is
 * `scripts/host-integration/start-host.mjs`, and this is a real, separately
 * spawned process that speaks the same launch protocol the real host speaks:
 * it prints a launch URL carrying a one-process token, exchanges that token for
 * an authority-bound `dsh-auth-*` cookie, and answers `POST /api/session/list`.
 * That is exactly the surface `startHost` drives, so driving it proves the
 * launcher's real behaviour (spawn, env isolation, token capture, redaction,
 * plugin probing, shutdown) without needing the full pinned dependency tree.
 *
 * Two behaviours exist purely to make the regressions honest:
 *
 * - the launch token is printed SPLIT ACROSS TWO stdout writes with a delay
 *   between them, which is the exact stream shape that used to leak the first
 *   half of a token into the log file;
 * - `--patch <overlay>` is really read, and a route is mounted only for the
 *   plugins the overlay actually inserts, so `pluginStatus()` is answered by
 *   the process rather than by the launcher's own bookkeeping.
 */
import { createServer } from 'node:http';
import { writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2)
/** Read one `--flag value` pair. */
const flag = (name) => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

const port = Number(flag('--port'))
const overlayPath = flag('--patch')
const dshHome = process.env.DSH_HOME ?? process.cwd()

// The launch token and the session cookie are synthetic values generated here.
// Nothing real is involved: the point is that the LAUNCHER must not leak them.
const TOKEN = process.env.AGOS_STUB_LAUNCH_VALUE ?? 'stubtok-0123456789abcdefghijklmnop'
const COOKIE_VALUE = process.env.AGOS_STUB_SESSION_VALUE ?? 'stubcookie-zyxwvutsrq9876543210'
/** A second synthetic secret that is NEVER registered — only its shape can save it. */
const SHAPED_SECRET = process.env.AGOS_STUB_SHAPED_VALUE ?? 'sk-STUBSHAPE0123456789abcdef'

// Evidence for the isolation assertions: what environment did the child
// actually receive, and where is it running?
writeFileSync(path.join(dshHome, 'stub-env.json'), JSON.stringify({
  env: process.env,
  cwd: process.cwd(),
  argv: process.argv,
}, undefined, 2))

/** Plugin ids the overlay asked the loader to insert. */
let insertedIds = []
try {
  const overlay = JSON.parse(readFileSync(overlayPath, 'utf8'))
  insertedIds = overlay.flatMap((entry) => entry.insert ?? []).map((entry) => entry.id)
} catch { /* no overlay: mount nothing */ }

/** Plugins whose route answers. `AGOS_STUB_FAIL_PLUGINS` marks ones that "failed to load". */
const failed = new Set((process.env.AGOS_STUB_FAIL_PLUGINS ?? '').split(',').filter(Boolean))
const mounted = insertedIds.filter((id) => !failed.has(id))

const server = createServer((request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${port}`)

  if (url.pathname === '/' && url.searchParams.get('token') === TOKEN) {
    response.writeHead(200, {
      'set-cookie': `dsh-auth-stub=${COOKIE_VALUE}; Path=/; HttpOnly`,
      'content-type': 'text/html',
    })
    response.end('<html><body>stub host</body></html>')
    return
  }

  const cookie = request.headers.cookie ?? ''
  if (!cookie.includes(`dsh-auth-stub=${COOKIE_VALUE}`)) {
    response.writeHead(401, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: 'no session cookie' }))
    return
  }

  let body = ''
  request.on('data', (chunk) => { body += chunk })
  request.on('end', () => {
    const parsed = (() => { try { return JSON.parse(body) } catch { return {} } })()
    const reply = (status, payload) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(payload))
    }
    if (url.pathname === '/api/session/list') {
      reply(200, { type: 'server-response', rpcId: parsed.rpcId, result: { ok: true, value: { items: [] } } })
      return
    }
    // One route per mounted plugin id, so a probe distinguishes "loaded" from
    // "the loader never mounted it" the way a real 404 would.
    const pluginRoute = /^\/api\/plugin\/([^/]+)\//.exec(url.pathname)
    if (pluginRoute !== null && mounted.includes(pluginRoute[1])) {
      reply(200, { type: 'server-response', rpcId: parsed.rpcId, result: { ok: true, value: { plugin: pluginRoute[1] } } })
      return
    }
    reply(404, { error: 'not found' })
  })
})

server.listen(port, '127.0.0.1', () => {
  // The launch URL, split so the token straddles a chunk boundary — the shape
  // that used to write the first half of the token into the log in the clear.
  const url = `http://127.0.0.1:${port}/?token=${TOKEN}`
  const cut = url.length - 12
  process.stdout.write(`dsh listening\nopen ${url.slice(0, cut)}`)
  setTimeout(() => {
    process.stdout.write(`${url.slice(cut)}\n`)
    // A second secret that is never registered: only the shape rules can catch
    // it, and it too is split mid-value.
    process.stdout.write(`api key ${SHAPED_SECRET.slice(0, 10)}`)
    setTimeout(() => {
      process.stdout.write(`${SHAPED_SECRET.slice(10)}\n`)
      process.stdout.write('宿主已就绪:合成中文日志行\n')
      process.stdout.write(`mounted plugins: ${mounted.join(',') || '(none)'}\n`)
    }, 40)
  }, 40)
})

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => { server.close(); process.exit(0) })
}
