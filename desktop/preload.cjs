'use strict'
// The page stays a plain web app; it only learns that it sits in a desktop window, to make room for the window controls.
const { contextBridge } = require('electron')

contextBridge.exposeInMainWorld('whiplashDesktop', { platform: process.platform })
