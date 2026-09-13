'use strict'

/**
 * Electron adapter for the AgOS desktop shell.
 * The TypeScript contract in src/desktop/shell.ts is the authority; this file
 * only re-validates the URL the CLI already probed and loadURLs it.
 */
function documentedUrl(value) {
  if (value === 'http://127.0.0.1:3091/agos/' || value === 'http://127.0.0.1:3092/agos/') return value
  return null
}

function allowedNavigation(candidate, allowed) {
  let next
  try { next = new URL(candidate) } catch { return false }
  let base
  try { base = new URL(allowed) } catch { return false }
  if (next.protocol !== 'http:' || next.hostname !== '127.0.0.1') return false
  if (next.port !== base.port) return false
  return next.pathname === '/agos' || next.pathname.startsWith('/agos/')
}

const url = documentedUrl(process.argv[2] || process.env.AGOS_DESKTOP_URL)
if (!url) {
  console.error('desktop-main: refused URL (loopback /agos/ only)')
  process.exit(2)
}

const { app, BrowserWindow } = require('electron')

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    autoHideMenuBar: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      navigateOnDragDrop: false,
    },
  })
  win.webContents.on('will-navigate', (event, nav) => {
    if (!allowedNavigation(nav, url)) event.preventDefault()
  })
  win.webContents.on('will-redirect', (event, nav) => {
    if (!allowedNavigation(nav, url)) event.preventDefault()
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.loadURL(url)
})
