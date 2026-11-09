import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { ChromeNotFound, findChrome, readDevToolsPort } from './browser.ts'

const temp = (): string => mkdtempSync(join(tmpdir(), 'whiplash-browser-'))
const touch = (path: string): string => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, '')
  return path
}

test('readDevToolsPort reads the first line, and nothing from a missing or broken file', () => {
  const profile = temp()
  assert.equal(readDevToolsPort(profile), null)
  writeFileSync(join(profile, 'DevToolsActivePort'), '53211\n/devtools/browser/abc\n')
  assert.equal(readDevToolsPort(profile), 53211)
  writeFileSync(join(profile, 'DevToolsActivePort'), 'garbage')
  assert.equal(readDevToolsPort(profile), null)
  writeFileSync(join(profile, 'DevToolsActivePort'), '0\n')
  assert.equal(readDevToolsPort(profile), null)
})

test('findChrome prefers Google Chrome, then the newest Chrome for Testing, else fails', () => {
  const root = temp()
  const app = join(root, 'Google Chrome')
  const testing = join(root, 'browsers')
  const binary = 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
  assert.throws(() => findChrome(app, testing), ChromeNotFound)
  touch(join(testing, 'chrome-130.0.1', 'chrome-mac-arm64', binary))
  const newest = touch(join(testing, 'chrome-131.0.2', 'chrome-mac-arm64', binary))
  assert.equal(findChrome(app, testing), newest)
  touch(app)
  assert.equal(findChrome(app, testing), app)
})
