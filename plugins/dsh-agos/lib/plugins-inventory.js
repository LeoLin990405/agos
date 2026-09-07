// Read-only plugin inventory. Never enable/disable. No secrets.
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const AGOS_PLUGIN_IDS = Object.freeze([
  'dsh-agos',
  'dsh-agos-router',
  'dsh-fleet',
  'cn-capabilities',
  'dsh-mcp-bridge',
])

export const INVENTORY_COPY = '只读投影。启停仍走 profile 的 package.json 与 cordis.patch.yml。'

function safeJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

function listPluginDirs(root) {
  if (!existsSync(root)) return []
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

function cordisIds(path) {
  if (!existsSync(path)) return []
  try {
    const ids = []
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const match = /^-\s+id:\s+([A-Za-z0-9._-]+)\s*$/.exec(line.trim())
      if (match) ids.push(match[1])
    }
    return ids
  } catch {
    return []
  }
}

function walkFiles(root, files = []) {
  let entries
  try { entries = readdirSync(root, { withFileTypes: true }) } catch { return files }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const path = join(root, entry.name)
    if (entry.isDirectory()) walkFiles(path, files)
    else if (entry.isFile()) files.push(path)
  }
  return files
}

export function hashPluginTree(root) {
  if (!existsSync(root)) return undefined
  const hash = createHash('sha1')
  for (const file of walkFiles(root).sort()) {
    hash.update(file.slice(root.length))
    try {
      const identity = statSync(file)
      if (!identity.isFile()) continue
      hash.update(readFileSync(file))
    } catch { /* skip unreadable */ }
  }
  return hash.digest('hex')
}

function profileInventory(name, profileRoot, repoPlugins) {
  const pluginsRoot = join(profileRoot, 'plugins')
  const pkg = safeJson(join(profileRoot, 'package.json'))
  const bundles = Array.isArray(pkg?.dsh?.profile?.bundles)
    ? pkg.dsh.profile.bundles.filter((id) => typeof id === 'string')
    : undefined
  const dirs = listPluginDirs(pluginsRoot)
  const cordis = cordisIds(join(profileRoot, 'cordis.patch.yml'))
  const plugins = dirs.map((id) => {
    const installed = join(pluginsRoot, id)
    const repo = repoPlugins ? join(repoPlugins, id) : undefined
    const agos = AGOS_PLUGIN_IDS.includes(id)
    const installedHash = agos ? hashPluginTree(installed) : undefined
    const repoHash = agos && repo && existsSync(repo) ? hashPluginTree(repo) : undefined
    const drift = installedHash !== undefined && repoHash !== undefined
      ? installedHash !== repoHash
      : undefined
    return {
      id,
      kind: agos ? 'agos' : 'host',
      present: true,
      ...(drift === undefined ? {} : { drift }),
    }
  })
  return {
    name,
    path: profileRoot,
    present: existsSync(profileRoot),
    bundles,
    cordisIds: cordis,
    pluginCount: dirs.length,
    plugins,
  }
}

export function detectCurrentProfile(options = {}) {
  if (options.profile === 'web' || options.profile === 'desktop') return options.profile
  const env = options.env ?? process.env
  if (env.DSH_PROFILE === 'web' || env.DSH_PROFILE === 'desktop') return env.DSH_PROFILE
  const argv = options.argv ?? process.argv
  const flag = argv.indexOf('--profile')
  if (flag !== -1 && (argv[flag + 1] === 'web' || argv[flag + 1] === 'desktop')) {
    return argv[flag + 1]
  }
  const here = options.here ?? ''
  if (here.includes(`${sep}profiles${sep}web${sep}`)) return 'web'
  if (here.includes(`${sep}profiles${sep}desktop${sep}`)) return 'desktop'
  return undefined
}

export function buildPluginsInventory(options = {}) {
  const home = options.home ?? homedir()
  const repoPlugins = options.repoPlugins
    ?? (existsSync(join(home, 'Projects', 'agos', 'plugins'))
      ? join(home, 'Projects', 'agos', 'plugins')
      : undefined)
  const web = profileInventory('web', join(home, '.dsh', 'profiles', 'web'), repoPlugins)
  const desktop = profileInventory('desktop', join(home, '.dsh', 'profiles', 'desktop'), repoPlugins)
  const agos = AGOS_PLUGIN_IDS.map((id) => {
    const webRow = web.plugins.find((row) => row.id === id)
    const desktopRow = desktop.plugins.find((row) => row.id === id)
    return {
      id,
      web: webRow?.present === true,
      desktop: desktopRow?.present === true,
      drift: webRow?.drift === true || desktopRow?.drift === true
        ? true
        : (webRow?.drift === false && desktopRow?.drift === false) || (webRow?.drift === false && desktopRow === undefined) || (desktopRow?.drift === false && webRow === undefined)
          ? false
          : undefined,
    }
  })
  const here = options.here ?? fileURLToPath(new URL('.', import.meta.url))
  const currentProcess = detectCurrentProfile({ ...options, here })
  return {
    at: typeof options.now === 'function' ? options.now() : Date.now(),
    copy: INVENTORY_COPY,
    writable: false,
    repoPlugins: repoPlugins && existsSync(repoPlugins) ? repoPlugins : undefined,
    currentProcess,
    agos,
    profiles: [web, desktop],
  }
}
