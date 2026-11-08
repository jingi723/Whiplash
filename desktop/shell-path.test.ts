import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { it } from 'node:test'

const { parseCapturedPath } = createRequire(import.meta.url)('./shell-path.cjs')

it('reads the PATH between the markers, ignoring rc noise and escapes, in shell order', () => {
  const out = 'Welcome!\x1b[32m\x1b[0m__WHIPLASH_SHELL_PATH__/a/bin:/opt/homebrew/bin:/a/bin__WHIPLASH_SHELL_PATH__% '
  assert.deepEqual(parseCapturedPath(out), ['/a/bin', '/opt/homebrew/bin'])
  assert.deepEqual(parseCapturedPath('no markers'), [])
})
