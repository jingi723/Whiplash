import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isShiftEnter, TERMINAL_SHIFT_ENTER_INPUT } from './terminal-shift-enter.js'

const key = (mods = {}) => ({ key: 'Enter', shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, isComposing: false, ...mods })

test('only bare Shift+Enter becomes ESC CR', () => {
  assert.equal(TERMINAL_SHIFT_ENTER_INPUT, '\x1b\r')
  assert.equal(isShiftEnter(key({ shiftKey: true })), true)
  assert.equal(isShiftEnter(key()), false)
  assert.equal(isShiftEnter(key({ shiftKey: true, ctrlKey: true })), false)
  assert.equal(isShiftEnter(key({ shiftKey: true, isComposing: true })), false)
  assert.equal(isShiftEnter({ ...key({ shiftKey: true }), key: 'a' }), false)
})
