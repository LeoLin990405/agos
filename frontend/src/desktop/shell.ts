/**
 * Thin AgOS desktop shell contract.
 *
 * Inventory (2026-09-12, this tree): no Electron/Tauri/asar sources in-repo.
 * `/Applications/DSH Desktop.app` is the old asar host (out of tree — do not
 * copy). `/Applications/AgOS.app` vendors a built SPA under Resources/web
 * (a second UI — not this cut). dsh-agos already serves the SPA at `/agos`
 * (`serveSpa`). Vite `npm run dev` is port 3092 (`vite.config.ts`); the host
 * is 3091. This module only plans a `loadURL` of those two loopback origins.
 *
 * Not an official host-browser scenario. No second SPA. No credential writes.
 * Privileged host methods stay behind the web origin's own loopback gate.
 */
import { accessSync, constants } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { createRequire } from 'node:module'

export const DESKTOP_LOOPBACK_HOST = '127.0.0.1'
/** Vite `server.port` in vite.config.ts — not the host port. */
export const DESKTOP_DEV_PORT = '3092'
/** dsh-agos `serveSpa` on the local host. */
export const DESKTOP_PROD_PORT = '3091'
export const DESKTOP_APP_PATH = '/agos/'

export type DesktopShellMode = 'development' | 'production'

export const DESKTOP_SHELL_URLS: Readonly<Record<DesktopShellMode, string>> = {
  development: `http://${DESKTOP_LOOPBACK_HOST}:${DESKTOP_DEV_PORT}${DESKTOP_APP_PATH}`,
  production: `http://${DESKTOP_LOOPBACK_HOST}:${DESKTOP_PROD_PORT}${DESKTOP_APP_PATH}`,
}

export const DESKTOP_SHELL_UNKNOWN_ARGV_EXIT = 78
export const DESKTOP_SHELL_REFUSED_EXIT = 2
export const DESKTOP_SHELL_RUNTIME_MISSING_EXIT = 78

export type DesktopShellErrorCode = 'forbidden-origin' | 'origin-down' | 'runtime-missing' | 'unknown-argv'

export class DesktopShellError extends Error {
  readonly code: DesktopShellErrorCode

  constructor(code: DesktopShellErrorCode, message: string) {
    super(message)
    this.name = 'DesktopShellError'
    this.code = code
  }
}

export type DesktopRequester = (url: string) => Promise<{ status: number }>

export type DesktopWindowHost = {
  loadURL: (url: string) => Promise<void> | void
}

export type DesktopShellArgv = {
  mode: DesktopShellMode
  origin?: string
  probeOnly: boolean
  help: boolean
}

export function resolveDesktopMode(input?: string | null): DesktopShellMode {
  const raw = (input ?? '').trim()
  if (raw === '' || raw === 'production' || raw === 'prod') return 'production'
  if (raw === 'development' || raw === 'dev') return 'development'
  throw new DesktopShellError('forbidden-origin', `unknown desktop mode: ${raw}`)
}

export function isDocumentedDesktopUrl(url: string): boolean {
  return url === DESKTOP_SHELL_URLS.development || url === DESKTOP_SHELL_URLS.production
}

export function normalizeDesktopOrigin(raw: string): string {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new DesktopShellError('forbidden-origin', `desktop shell refuses ${raw}`)
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new DesktopShellError('forbidden-origin', 'desktop shell refuses authenticated origins')
  }
  if (parsed.protocol !== 'http:') {
    throw new DesktopShellError('forbidden-origin', `desktop shell refuses ${parsed.protocol}`)
  }
  if (parsed.hostname !== DESKTOP_LOOPBACK_HOST) {
    throw new DesktopShellError('forbidden-origin', `desktop shell refuses host ${parsed.hostname}`)
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new DesktopShellError('forbidden-origin', 'desktop shell refuses query or hash on the origin')
  }
  const path = parsed.pathname === '/agos' ? DESKTOP_APP_PATH : parsed.pathname
  const normalized = `http://${DESKTOP_LOOPBACK_HOST}:${parsed.port}${path}`
  if (!isDocumentedDesktopUrl(normalized)) {
    throw new DesktopShellError('forbidden-origin', `desktop shell refuses ${raw}`)
  }
  return normalized
}

export function resolveDesktopLoadUrl(options: {
  mode?: string | null
  origin?: string | null
} = {}): string {
  const documented = DESKTOP_SHELL_URLS[resolveDesktopMode(options.mode)]
  const override = options.origin?.trim()
  if (override === undefined || override === '') return documented
  return normalizeDesktopOrigin(override)
}

/**
 * Window navigations may stay under `/agos/` (SPA + assets) on the same
 * documented loopback port. Root `/` is the upstream host UI — refuse it.
 */
export function isAllowedDesktopNavigation(candidate: string, allowedUrl: string): boolean {
  if (!isDocumentedDesktopUrl(allowedUrl)) return false
  let next: URL
  try {
    next = new URL(candidate)
  } catch {
    return false
  }
  if (next.protocol !== 'http:' || next.hostname !== DESKTOP_LOOPBACK_HOST) return false
  const allowed = new URL(allowedUrl)
  if (next.port !== allowed.port) return false
  return next.pathname === '/agos' || next.pathname.startsWith(DESKTOP_APP_PATH)
}

export async function probeDesktopOrigin(
  url: string,
  options: { request?: DesktopRequester } = {},
): Promise<{ ok: true; status: number; url: string } | { ok: false; url: string; detail: string }> {
  if (!isDocumentedDesktopUrl(url)) {
    return { ok: false, url, detail: 'undocumented origin' }
  }
  const request = options.request ?? defaultDesktopRequest
  try {
    const { status } = await request(url)
    if (status !== 200) return { ok: false, url, detail: `HTTP ${status}` }
    return { ok: true, status, url }
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'origin down'
    return { ok: false, url, detail }
  }
}

export async function prepareDesktopLoad(options: {
  mode?: string | null
  origin?: string | null
  request?: DesktopRequester
} = {}): Promise<{ url: string; status: number }> {
  const url = resolveDesktopLoadUrl(options)
  const probe = await probeDesktopOrigin(url, options)
  if (!probe.ok) {
    throw new DesktopShellError('origin-down', `desktop origin down: ${probe.url} (${probe.detail})`)
  }
  return { url: probe.url, status: probe.status }
}

export async function loadDesktopWindow(
  host: DesktopWindowHost,
  options: {
    mode?: string | null
    origin?: string | null
    request?: DesktopRequester
  } = {},
): Promise<{ url: string }> {
  const prepared = await prepareDesktopLoad(options)
  await host.loadURL(prepared.url)
  return { url: prepared.url }
}

export function parseDesktopShellArgv(argv: readonly string[]): DesktopShellArgv {
  let mode: DesktopShellMode = 'production'
  let origin: string | undefined
  let probeOnly = false
  let help = false
  for (const token of argv) {
    if (token === '--help' || token === '-h') {
      help = true
      continue
    }
    if (token === '--probe-only') {
      probeOnly = true
      continue
    }
    if (token === '--mode' || token === '--origin') {
      throw new DesktopShellError('unknown-argv', `${token} needs --name=value`)
    }
    if (token.startsWith('--mode=')) {
      mode = resolveDesktopMode(token.slice('--mode='.length))
      continue
    }
    if (token.startsWith('--origin=')) {
      origin = token.slice('--origin='.length)
      continue
    }
    throw new DesktopShellError('unknown-argv', `unknown flag ${token}`)
  }
  return { mode, origin, probeOnly, help }
}

export const DESKTOP_SHELL_USAGE = [
  'AgOS desktop shell — loadURL the local AgOS web origin. No second SPA.',
  '',
  '  npm run desktop                         production  http://127.0.0.1:3091/agos/',
  '  npm run desktop -- --mode=development   Vite        http://127.0.0.1:3092/agos/',
  '  npm run desktop -- --probe-only         fail-closed check, no window',
  '',
  'Origin must already be up. Without Electron, --probe-only still works;',
  'a window needs AGOS_ELECTRON_BINARY or `electron` on PATH. This is not',
  'an official host-browser scenario.',
].join('\n')

export function resolveElectronBinary(options: {
  env?: NodeJS.ProcessEnv
  canExecute?: (path: string) => boolean
  resolveModule?: () => string | null
  lookupPath?: (name: string) => string | null
} = {}): string | null {
  const env = options.env ?? {}
  const canExecute = options.canExecute ?? defaultCanExecute
  const explicit = env.AGOS_ELECTRON_BINARY?.trim()
  if (explicit) return canExecute(explicit) ? explicit : null
  const fromModule = (options.resolveModule ?? defaultResolveElectronModule)()
  if (fromModule && canExecute(fromModule)) return fromModule
  const fromPath = (options.lookupPath ?? defaultWhich)('electron')
  if (fromPath && canExecute(fromPath)) return fromPath
  return null
}

export async function runDesktopShell(options: {
  argv: readonly string[]
  env?: NodeJS.ProcessEnv
  request?: DesktopRequester
  resolveElectron?: () => string | null
  spawnElectron?: (bin: string, args: readonly string[]) => Promise<number>
  mainPath?: string
  stdout?: { write(chunk: string): void }
  stderr?: { write(chunk: string): void }
}): Promise<number> {
  const out = options.stdout ?? { write: (chunk: string) => { process.stdout.write(chunk) } }
  const err = options.stderr ?? { write: (chunk: string) => { process.stderr.write(chunk) } }
  let parsed: DesktopShellArgv
  try {
    parsed = parseDesktopShellArgv(options.argv)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown argv'
    err.write(`${message}\n`)
    return DESKTOP_SHELL_UNKNOWN_ARGV_EXIT
  }
  if (parsed.help) {
    out.write(`${DESKTOP_SHELL_USAGE}\n`)
    return 0
  }

  let prepared: { url: string; status: number }
  try {
    prepared = await prepareDesktopLoad({
      mode: parsed.mode,
      origin: parsed.origin,
      request: options.request,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'origin down'
    err.write(`${message}\n`)
    return DESKTOP_SHELL_REFUSED_EXIT
  }

  out.write(`${prepared.url}\n`)
  if (parsed.probeOnly) return 0

  const electron = (options.resolveElectron ?? (() => resolveElectronBinary({ env: options.env })))()
  if (electron === null) {
    err.write('desktop runtime missing: no Electron on PATH or AGOS_ELECTRON_BINARY. Contract still holds; window not opened.\n')
    return DESKTOP_SHELL_RUNTIME_MISSING_EXIT
  }
  const mainPath = options.mainPath
  if (mainPath === undefined || mainPath === '') {
    err.write('desktop-main path missing\n')
    return DESKTOP_SHELL_REFUSED_EXIT
  }
  const spawn = options.spawnElectron
  if (spawn === undefined) {
    err.write('desktop spawn hook missing\n')
    return DESKTOP_SHELL_REFUSED_EXIT
  }
  return spawn(electron, [mainPath, prepared.url])
}

function defaultCanExecute(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function defaultResolveElectronModule(): string | null {
  try {
    const resolved = createRequire(import.meta.url)('electron') as unknown
    return typeof resolved === 'string' && resolved !== '' ? resolved : null
  } catch {
    return null
  }
}

function defaultWhich(name: string): string | null {
  const pathVar = process.env.PATH
  if (pathVar === undefined || pathVar === '') return null
  for (const dir of pathVar.split(':')) {
    if (dir === '') continue
    const candidate = `${dir}/${name}`
    if (defaultCanExecute(candidate)) return candidate
  }
  return null
}

function defaultDesktopRequest(url: string): Promise<{ status: number }> {
  if (!isDocumentedDesktopUrl(url)) {
    return Promise.reject(new DesktopShellError('forbidden-origin', 'desktop request refuses undocumented origin'))
  }
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const req = httpRequest(
      {
        protocol: 'http:',
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: 'GET',
        timeout: 2000,
      },
      (response) => {
        response.resume()
        resolve({ status: response.statusCode ?? 0 })
      },
    )
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('timeout'))
    })
    req.on('error', reject)
    req.end()
  })
}
