'use strict'
// The page stays a plain web app; it only learns that it sits in a desktop window, to make room for the
// window controls, can turn a dropped file into its path on disk, and can reach the Dock badge and window.
const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('whiplashDesktop', {
  platform: process.platform,
  pathForFile: (file) => webUtils.getPathForFile(file),
  setBadge: (count) => ipcRenderer.send('whiplash:badge', Number(count) || 0),
  focus: () => ipcRenderer.send('whiplash:focus'),
  pickFolder: () => ipcRenderer.invoke('whiplash:pickFolder'),
  copyText: (text) => ipcRenderer.send('whiplash:copy', String(text))
})
