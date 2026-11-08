'use strict'
// Whiplash desktop: the same local server and page, in an Electron window like Orca's.
const { app, BrowserWindow, shell, nativeImage } = require('electron')
const { spawn } = require('node:child_process')
const { readFileSync, writeFileSync } = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const { hydrateShellPath } = require('./shell-path.cjs')

const DEFAULT_PORT = Number(process.env.PORT) || 4717
// Agent-run checks open the app without a visible window or Dock icon, so they never take focus.
const BACKGROUND = process.env.WHIPLASH_BACKGROUND_LAUNCH === '1'
const SERVER_READY_TIMEOUT_MS = 20_000
const root = path.join(__dirname, '..')
let server = null
let origin = ''

if (!app.requestSingleInstanceLock()) {
  app.quit()
}

function portIsFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.once('error', () => resolve(false))
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)))
  })
}

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

/** A Whiplash server already on the default port owns ~/.whiplash; a second writer would overwrite its state. */
async function runningWhiplash(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/terminal-appearance`, { signal: AbortSignal.timeout(1500) })
    return response.ok && typeof (await response.json()).fontFamily === 'string'
  } catch {
    return false
  }
}

function startServer(port) {
  return new Promise((resolve, reject) => {
    // Electron's own Node runs the server, so the app needs no system Node.
    server = spawn(process.execPath, [path.join(root, 'src', 'server.ts')], {
      cwd: root,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PORT: String(port) },
      stdio: ['ignore', 'pipe', 'inherit']
    })
    const timer = setTimeout(() => reject(new Error('Whiplash server did not start')), SERVER_READY_TIMEOUT_MS)
    server.stdout.on('data', (chunk) => {
      process.stdout.write(chunk)
      if (String(chunk).includes('Whiplash: http')) {
        clearTimeout(timer)
        resolve()
      }
    })
    server.once('exit', (code) => {
      clearTimeout(timer)
      server = null
      reject(new Error(`Whiplash server exited (${code})`))
    })
  })
}

async function ensureServer() {
  if (await runningWhiplash(DEFAULT_PORT)) return DEFAULT_PORT
  const port = (await portIsFree(DEFAULT_PORT)) ? DEFAULT_PORT : await freePort()
  await startServer(port)
  return port
}

const boundsFile = () => path.join(app.getPath('userData'), 'window-bounds.json')

function readBounds() {
  try {
    return JSON.parse(readFileSync(boundsFile(), 'utf8'))
  } catch {
    return { width: 1440, height: 900 }
  }
}

function createWindow() {
  const window = new BrowserWindow({
    ...readBounds(),
    minWidth: 900,
    minHeight: 560,
    title: 'Whiplash',
    show: !BACKGROUND,
    backgroundColor: '#141415',
    // Orca's frame: traffic lights float over the sidebar instead of a separate title bar.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  window.on('close', () => {
    try {
      writeFileSync(boundsFile(), JSON.stringify(window.getBounds()))
    } catch {}
  })
  // Only the local Whiplash page lives in the window; every other link opens in the browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(origin)) {
      event.preventDefault()
      if (/^https?:/.test(url)) void shell.openExternal(url)
    }
  })
  void window.loadURL(origin)
}

app.on('second-instance', () => {
  const [window] = BrowserWindow.getAllWindows()
  if (window) {
    if (window.isMinimized()) window.restore()
    window.focus()
  }
})

app.whenReady().then(async () => {
  if (process.platform === 'darwin' && BACKGROUND) app.dock.hide()
  else if (process.platform === 'darwin' && !app.isPackaged) {
    app.dock.setIcon(nativeImage.createFromPath(path.join(root, 'build', 'icon.png')))
  }
  await hydrateShellPath()
  try {
    origin = `http://127.0.0.1:${await ensureServer()}`
  } catch (error) {
    const { dialog } = require('electron')
    dialog.showErrorBox('Whiplash', String(error.message || error))
    app.quit()
    return
  }
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  // Only the server this app started is stopped; a server someone else runs keeps running.
  server?.kill('SIGTERM')
})
