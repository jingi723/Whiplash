'use strict'
// Whiplash desktop: the same local server and page, in an Electron window like Orca's.
const { app, BrowserWindow, clipboard, dialog, ipcMain, shell, nativeImage } = require('electron')
const { spawn } = require('node:child_process')
const { mkdirSync, openSync, readFileSync, writeFileSync } = require('node:fs')
const os = require('node:os')
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Starts the server on Electron's own Node, so the app needs no system Node. On the default port it is
 * detached, like Orca's terminal daemon: quitting the app leaves agents and their terminals running,
 * and the next launch reattaches. A fallback port is not found again on relaunch, so that server
 * stays tied to this app and stops with it rather than becoming a second writer of the same state.
 */
async function startServer(port) {
  const keep = port === DEFAULT_PORT
  const home = process.env.WHIPLASH_HOME || path.join(os.homedir(), '.whiplash')
  mkdirSync(home, { recursive: true })
  const log = openSync(path.join(home, 'server.log'), 'a')
  const child = spawn(process.execPath, [path.join(root, 'src', 'server.ts')], {
    cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PORT: String(port) },
    detached: keep,
    stdio: ['ignore', log, log]
  })
  if (keep) child.unref()
  else server = child
  let exited = null
  child.once('exit', (code) => (exited = code))
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (exited !== null) throw new Error(`Whiplash server exited (${exited}); see ${path.join(home, 'server.log')}`)
    if (await runningWhiplash(port)) return
    await sleep(200)
  }
  throw new Error('Whiplash server did not start')
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

// Only our own page can reach these; the window never loads another origin.
ipcMain.on('whiplash:badge', (_event, count) => app.setBadgeCount(Math.max(0, Math.floor(Number(count)) || 0)))
// The Finder's folder sheet, with its New Folder button.
// The page's clipboard API can fail silently in the window; the main process always can write.
ipcMain.on('whiplash:copy', (_event, text) => clipboard.writeText(String(text)))

ipcMain.handle('whiplash:pickFolder', async (event) => {
  const window = BrowserWindow.fromWebContents(event.sender)
  const { canceled, filePaths } = await dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'] })
  return canceled ? null : filePaths[0]
})
ipcMain.on('whiplash:focus', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
})

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
  // Only a fallback-port server is tied to the app; the default-port server outlives it.
  server?.kill('SIGTERM')
})
