import assert from 'node:assert/strict'
import { test } from 'node:test'
import { addressUrl, cdpKeyEvents, pagePoint } from './browser-input.js'

const key = (key, code, keyCode, mods = {}) => ({ key, code, keyCode, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...mods })

test('pagePoint maps the shown frame onto the page, past the top offset and pinch zoom', () => {
  const rect = { left: 100, top: 50, width: 640, height: 400 }
  const flat = { deviceWidth: 1280, deviceHeight: 800, offsetTop: 0, pageScaleFactor: 1 }
  assert.deepEqual(pagePoint(100, 50, rect, flat), { x: 0, y: 0 })
  assert.deepEqual(pagePoint(420, 250, rect, flat), { x: 640, y: 400 })
  assert.deepEqual(pagePoint(420, 250, rect, { ...flat, offsetTop: 40, pageScaleFactor: 2 }), { x: 320, y: 180 })
})

test('cdpKeyEvents sends Enter with its char, other named keys raw, and leaves text alone', () => {
  const [down, up] = cdpKeyEvents(key('Enter', 'Enter', 13))
  assert.deepEqual(down, { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: 0, type: 'keyDown', text: '\r' })
  assert.equal(up.type, 'keyUp')
  assert.equal(cdpKeyEvents(key('Backspace', 'Backspace', 8))[0].type, 'rawKeyDown')
  const [left] = cdpKeyEvents(key('ArrowLeft', 'ArrowLeft', 37, { shiftKey: true }))
  assert.equal(left.type, 'rawKeyDown')
  assert.equal(left.modifiers, 8)
  assert.deepEqual(cdpKeyEvents(key('a', 'KeyA', 65)), [])
  assert.deepEqual(cdpKeyEvents(key('ㅎ', 'KeyG', 229)), [])
})

test('cdpKeyEvents turns ⌘A and ⌘⇧Z into editing commands and leaves ⌘C/⌘V to the clipboard', () => {
  const [selectAll] = cdpKeyEvents(key('a', 'KeyA', 65, { metaKey: true }))
  assert.equal(selectAll.modifiers, 4)
  assert.deepEqual(selectAll.commands, ['selectAll'])
  assert.deepEqual(cdpKeyEvents(key('z', 'KeyZ', 90, { metaKey: true, shiftKey: true }))[0].commands, ['redo'])
  assert.deepEqual(cdpKeyEvents(key('v', 'KeyV', 86, { metaKey: true })), [])
  assert.equal(cdpKeyEvents(key('a', 'KeyA', 65, { ctrlKey: true }))[0].modifiers, 2)
})

test('addressUrl keeps a scheme and adds https to a bare host', () => {
  assert.equal(addressUrl(' example.com/a '), 'https://example.com/a')
  assert.equal(addressUrl('http://localhost:3000'), 'http://localhost:3000')
  assert.equal(addressUrl('about:blank'), 'about:blank')
  assert.equal(addressUrl('localhost:3000'), 'http://localhost:3000')
})
