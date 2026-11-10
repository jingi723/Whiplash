import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clampBounds, defaultBounds, maximizedBounds, parseState, resizeBounds } from './floating-panel.js'

const viewport = { width: 1440, height: 900 }

test('opens 920x560 at the bottom right', () => {
  assert.deepEqual(defaultBounds(viewport), { left: 1440 - 920 - 24, top: 900 - 560 - 84, width: 920, height: 560 })
})

test('clamps size and position into the window', () => {
  assert.deepEqual(clampBounds({ left: -50, top: 0, width: 100, height: 100 }, viewport), { left: 8, top: 36, width: 420, height: 280 })
  assert.deepEqual(clampBounds({ left: 2000, top: 2000, width: 5000, height: 5000 }, viewport), { left: 8, top: 36, width: 1424, height: 856 })
  assert.deepEqual(maximizedBounds(viewport), { left: 12, top: 36, width: 1416, height: 828 })
})

test('west and north edges stop at the minimum size', () => {
  const start = { left: 100, top: 100, width: 500, height: 400 }
  assert.deepEqual(resizeBounds(start, 'se', 20, 30), { left: 100, top: 100, width: 520, height: 430 })
  assert.deepEqual(resizeBounds(start, 'nw', 200, 200), { left: 180, top: 220, width: 300, height: 200 })
  assert.equal(clampBounds(resizeBounds(start, 'nw', 200, 200), viewport).width, 420)
})

test('reads only valid saved state', () => {
  assert.deepEqual(parseState('{"bounds":{"left":1,"top":2,"width":3,"height":4},"open":true}'), { bounds: { left: 1, top: 2, width: 3, height: 4 }, open: true, maximized: false })
  assert.deepEqual(parseState('{"bounds":{"left":"x"}}').bounds, null)
  assert.deepEqual(parseState('nope'), { bounds: null, open: false, maximized: false })
  assert.deepEqual(parseState(null), { bounds: null, open: false, maximized: false })
})
