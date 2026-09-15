import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { DESKTOP_SHELL_URLS } from './shell.ts'

const here = dirname(fileURLToPath(import.meta.url))
const frontendRoot = join(here, '..', '..')
const scriptFiles = ['desktop-shell.ts', 'desktop-main.cjs'] as const

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ')
}

function desktopSources(): { rel: string; text: string }[] {
  const files = readdirSync(here).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
  const fromSrc = files.map((name) => ({
    rel: `src/desktop/${name}`,
    text: readFileSync(join(here, name), 'utf8'),
  }))
  const fromScripts = scriptFiles.map((name) => ({
    rel: `scripts/${name}`,
    text: readFileSync(join(frontendRoot, 'scripts', name), 'utf8'),
  }))
  return [...fromSrc, ...fromScripts]
}

test('desktop shell source-lock: documented origin only, no privileged writes', () => {
  const sources = desktopSources()
  assert.ok(sources.some((file) => file.rel === 'src/desktop/shell.ts'))
  assert.ok(sources.some((file) => file.rel === 'scripts/desktop-main.cjs'))

  const lockedWrite = [
    'credentials/set',
    'settings/replace',
    'settings/update',
    ['routes', 'dec'.concat('ide')].join('/'),
    '/'.concat('dec', 'ide'),
  ]
  const joined = sources.map((file) => file.text).join('\n')
  const code = stripComments(joined)

  for (const token of lockedWrite) {
    assert.equal(joined.includes(token), false, `desktop sources must not contain ${token}`)
  }

  assert.match(joined, /http:\/\/127\.0\.0\.1:3091\/agos\//)
  assert.match(joined, /http:\/\/127\.0\.0\.1:3092\/agos\//)
  assert.equal(DESKTOP_SHELL_URLS.production, 'http://127.0.0.1:3091/agos/')
  assert.equal(DESKTOP_SHELL_URLS.development, 'http://127.0.0.1:3092/agos/')

  assert.doesNotMatch(code, /\bfetch\s*\(/)
  assert.doesNotMatch(code, /loadFile\s*\(/)
  assert.doesNotMatch(code, /openExternal/)
  assert.doesNotMatch(code, /\basar\b/i)
  assert.doesNotMatch(code, /file:\/\//)
  assert.doesNotMatch(joined, /from ['"]@\/(pages|components|fold|api-client|stores)/)
  assert.doesNotMatch(joined, /host-integration|scenarios\.mjs/)
  assert.match(joined, /Not an official host-browser scenario/)
})

test('Vite development origin is bound to 127.0.0.1:3092, not IPv6 localhost', () => {
  const vite = readFileSync(join(frontendRoot, 'vite.config.ts'), 'utf8')
  assert.match(vite, /host:\s*'127\.0\.0\.1'/)
  assert.match(vite, /port:\s*3092/)
  assert.match(vite, /base:\s*'\/agos\/'/)
})

test('electron main only loadURLs a CLI-validated documented origin', () => {
  const main = readFileSync(join(frontendRoot, 'scripts', 'desktop-main.cjs'), 'utf8')
  const cli = readFileSync(join(frontendRoot, 'scripts', 'desktop-shell.ts'), 'utf8')
  const shell = readFileSync(join(here, 'shell.ts'), 'utf8')

  assert.match(main, /loadURL/)
  assert.match(main, /http:\/\/127\.0\.0\.1:3091\/agos\//)
  assert.match(main, /http:\/\/127\.0\.0\.1:3092\/agos\//)
  assert.match(main, /nodeIntegration:\s*false/)
  assert.match(main, /sandbox:\s*true/)
  assert.match(main, /action:\s*['"]deny['"]/)
  assert.doesNotMatch(stripComments(main), /loadFile\s*\(/)
  assert.doesNotMatch(main, /credentials\/set/)
  assert.doesNotMatch(main, /host-browser/)

  assert.match(cli, /from ['"]\.\.\/src\/desktop\/shell\.ts['"]/)
  assert.match(cli, /runDesktopShell/)
  assert.match(shell, /Not an official host-browser scenario/)
})
