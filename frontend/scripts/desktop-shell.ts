/**
 * CLI for the thin AgOS desktop shell. Logic lives in src/desktop/shell.ts.
 */
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveElectronBinary, runDesktopShell } from '../src/desktop/shell.ts'

const here = dirname(fileURLToPath(import.meta.url))

const code = await runDesktopShell({
  argv: process.argv.slice(2),
  env: process.env,
  mainPath: join(here, 'desktop-main.cjs'),
  resolveElectron: () => resolveElectronBinary({ env: process.env }),
  spawnElectron: (bin, args) => new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (status) => resolve(status ?? 1))
  }),
})

process.exit(code)
