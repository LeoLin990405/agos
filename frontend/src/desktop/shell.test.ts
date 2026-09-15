import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DESKTOP_SHELL_REFUSED_EXIT,
  DESKTOP_SHELL_RUNTIME_MISSING_EXIT,
  DESKTOP_SHELL_UNKNOWN_ARGV_EXIT,
  DESKTOP_SHELL_URLS,
  DesktopShellError,
  isAllowedDesktopNavigation,
  loadDesktopWindow,
  parseDesktopShellArgv,
  probeDesktopOrigin,
  resolveDesktopLoadUrl,
  resolveElectronBinary,
  runDesktopShell,
} from './shell.ts'

test('loadURL targets are the documented loopback AgOS origins', () => {
  assert.equal(resolveDesktopLoadUrl(), DESKTOP_SHELL_URLS.production)
  assert.equal(resolveDesktopLoadUrl({ mode: 'production' }), 'http://127.0.0.1:3091/agos/')
  assert.equal(resolveDesktopLoadUrl({ mode: 'development' }), 'http://127.0.0.1:3092/agos/')
  assert.equal(resolveDesktopLoadUrl({ origin: 'http://127.0.0.1:3091/agos' }), DESKTOP_SHELL_URLS.production)
  assert.equal(resolveDesktopLoadUrl({ origin: 'http://127.0.0.1:3092/agos/' }), DESKTOP_SHELL_URLS.development)
})

test('origin resolver is loopback-only and fail-closed', () => {
  const rejected = [
    'http://localhost:3091/agos/',
    'http://[::1]:3091/agos/',
    'https://127.0.0.1:3091/agos/',
    'http://127.0.0.1:3091/',
    'http://127.0.0.1:3091/api/session/list',
    'http://127.0.0.1:4173/agos/',
    'http://127.0.0.1:3091/agos/?x=1',
    'http://127.0.0.1:3091/agos/#chat',
    'http://user:pass@127.0.0.1:3091/agos/',
    'file:///agos/index.html',
  ]
  for (const origin of rejected) {
    assert.throws(() => resolveDesktopLoadUrl({ origin }), DesktopShellError)
  }
  assert.throws(() => resolveDesktopLoadUrl({ mode: 'staging' }), /unknown desktop mode/)
})

test('window navigation stays under /agos/ on the same documented port', () => {
  const allowed = DESKTOP_SHELL_URLS.production
  assert.equal(isAllowedDesktopNavigation('http://127.0.0.1:3091/agos/', allowed), true)
  assert.equal(isAllowedDesktopNavigation('http://127.0.0.1:3091/agos/assets/index.js', allowed), true)
  assert.equal(isAllowedDesktopNavigation('http://127.0.0.1:3091/', allowed), false)
  assert.equal(isAllowedDesktopNavigation('http://127.0.0.1:3091/api/session/list', allowed), false)
  assert.equal(isAllowedDesktopNavigation('http://127.0.0.1:3092/agos/', allowed), false)
  assert.equal(isAllowedDesktopNavigation('https://example.com/', allowed), false)
  assert.equal(isAllowedDesktopNavigation('http://127.0.0.1:3091/agos/', 'http://example.com/agos/'), false)
})

test('probe fails closed unless the documented origin returns 200', async () => {
  const hits: string[] = []
  const up = await probeDesktopOrigin(DESKTOP_SHELL_URLS.production, {
    request: async (url) => {
      hits.push(url)
      return { status: 200 }
    },
  })
  assert.deepEqual(up, { ok: true, status: 200, url: DESKTOP_SHELL_URLS.production })
  assert.deepEqual(hits, [DESKTOP_SHELL_URLS.production])

  const missing = await probeDesktopOrigin(DESKTOP_SHELL_URLS.production, {
    request: async () => ({ status: 404 }),
  })
  assert.equal(missing.ok, false)

  const refused = await probeDesktopOrigin(DESKTOP_SHELL_URLS.development, {
    request: async () => {
      throw new Error('connect ECONNREFUSED')
    },
  })
  assert.equal(refused.ok, false)
  assert.match(refused.detail, /ECONNREFUSED/)

  const sneakyHits: string[] = []
  const sneaky = await probeDesktopOrigin('http://127.0.0.1:3091/', {
    request: async (url) => {
      sneakyHits.push(url)
      return { status: 200 }
    },
  })
  assert.deepEqual(sneaky, { ok: false, url: 'http://127.0.0.1:3091/', detail: 'undocumented origin' })
  assert.deepEqual(sneakyHits, [])
})

test('loadDesktopWindow only loadURLs after a 200 probe', async () => {
  const loaded: string[] = []
  const host = { loadURL: (url: string) => { loaded.push(url) } }
  const result = await loadDesktopWindow(host, {
    mode: 'development',
    request: async () => ({ status: 200 }),
  })
  assert.deepEqual(result, { url: DESKTOP_SHELL_URLS.development })
  assert.deepEqual(loaded, [DESKTOP_SHELL_URLS.development])

  await assert.rejects(
    () => loadDesktopWindow(host, { request: async () => ({ status: 503 }) }),
    /origin down/,
  )
  assert.deepEqual(loaded, [DESKTOP_SHELL_URLS.development])
})

test('argv is fail-closed and the CLI does not spawn on a down origin', async () => {
  assert.deepEqual(parseDesktopShellArgv([]), { mode: 'production', origin: undefined, probeOnly: false, help: false })
  assert.deepEqual(parseDesktopShellArgv(['--mode=development', '--probe-only']), {
    mode: 'development',
    origin: undefined,
    probeOnly: true,
    help: false,
  })
  assert.throws(() => parseDesktopShellArgv(['--mode']), /needs --name=value/)
  assert.throws(() => parseDesktopShellArgv(['--write-floors']), /unknown flag/)

  const spawned: unknown[] = []
  const down = await runDesktopShell({
    argv: [],
    request: async () => ({ status: 503 }),
    resolveElectron: () => '/tmp/electron-should-not-run',
    spawnElectron: async (bin, args) => {
      spawned.push([bin, args])
      return 0
    },
    mainPath: '/tmp/desktop-main.cjs',
    stdout: { write() {} },
    stderr: { write() {} },
  })
  assert.equal(down, DESKTOP_SHELL_REFUSED_EXIT)
  assert.deepEqual(spawned, [])
})

test('probe-only prints the origin; missing Electron is blocked 78', async () => {
  const lines: string[] = []
  const probe = await runDesktopShell({
    argv: ['--probe-only'],
    request: async () => ({ status: 200 }),
    resolveElectron: () => {
      throw new Error('should not resolve electron for probe-only')
    },
    spawnElectron: async () => {
      throw new Error('should not spawn')
    },
    stdout: { write(chunk) { lines.push(chunk) } },
    stderr: { write() {} },
  })
  assert.equal(probe, 0)
  assert.deepEqual(lines, [`${DESKTOP_SHELL_URLS.production}\n`])

  const missing = await runDesktopShell({
    argv: [],
    request: async () => ({ status: 200 }),
    resolveElectron: () => null,
    spawnElectron: async () => {
      throw new Error('should not spawn')
    },
    mainPath: '/tmp/desktop-main.cjs',
    stdout: { write() {} },
    stderr: { write() {} },
  })
  assert.equal(missing, DESKTOP_SHELL_RUNTIME_MISSING_EXIT)

  const unknown = await runDesktopShell({
    argv: ['--ghost'],
    stdout: { write() {} },
    stderr: { write() {} },
  })
  assert.equal(unknown, DESKTOP_SHELL_UNKNOWN_ARGV_EXIT)
})

test('explicit Electron override is fail-closed when the binary is missing', () => {
  assert.equal(
    resolveElectronBinary({
      env: { AGOS_ELECTRON_BINARY: '/definitely-missing-agos-electron' },
      canExecute: () => false,
      resolveModule: () => '/would-have-fallen-through',
      lookupPath: () => '/usr/bin/electron',
    }),
    null,
  )
  assert.equal(
    resolveElectronBinary({
      env: { AGOS_ELECTRON_BINARY: '/opt/agos-electron' },
      canExecute: (path) => path === '/opt/agos-electron',
    }),
    '/opt/agos-electron',
  )
})
