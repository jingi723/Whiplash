import assert from 'node:assert/strict'
import { it } from 'node:test'
import { createColorQueryResponder, oscRgb, replyFor } from './terminal-color-queries.ts'

const colors = { foreground: '#ffffff', background: '#282c34' }

it('answers OSC 10/11 in xterm form with the query terminator, and ?996n by background luminance', () => {
  assert.equal(oscRgb('#282c34'), 'rgb:2828/2c2c/3434')
  assert.equal(replyFor('\x1b]11;?\x1b\\', colors), '\x1b]11;rgb:2828/2c2c/3434\x1b\\')
  assert.equal(replyFor('\x1b]10;?\x07', colors), '\x1b]10;rgb:ffff/ffff/ffff\x07')
  assert.equal(replyFor('\x1b[?996n', colors), '\x1b[?997;1n')
  assert.equal(replyFor('\x1b[?996n', { foreground: '#000', background: '#fff' }), '\x1b[?997;2n')
})

it('strips answered queries, including one torn across chunks', () => {
  const replies: string[] = []
  const respond = createColorQueryResponder((reply) => replies.push(reply))
  assert.equal(respond('hi\x1b]10;?\x1b\\there\x1b]1'), 'hithere')
  assert.equal(respond('1;?\x1b\\!'), '!')
  assert.equal(replies.length, 2)
  assert.ok(replies[1].startsWith('\x1b]11;rgb:'))
  assert.equal(respond('plain \x1b[31mred'), 'plain \x1b[31mred')
})
