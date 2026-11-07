import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTranslator, MESSAGES, pickLocale } from './i18n.js'

const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map(([, name]) => name).sort()

describe('i18n', () => {
  it('gives every key and placeholder in both languages', () => {
    assert.deepEqual(Object.keys(MESSAGES.ko).sort(), Object.keys(MESSAGES.en).sort())
    for (const key of Object.keys(MESSAGES.en)) {
      assert.deepEqual(placeholders(MESSAGES.ko[key]), placeholders(MESSAGES.en[key]), key)
    }
  })

  it('prefers the saved choice, then the browser, then English', () => {
    assert.equal(pickLocale('ko', ['en-US']), 'ko')
    assert.equal(pickLocale(null, ['fr-FR', 'ko-KR']), 'ko')
    assert.equal(pickLocale('xx', ['fr-FR']), 'en')
  })

  it('fills placeholders and falls back to English', () => {
    assert.equal(createTranslator('ko')('time.minutes', { count: 3 }), '3분 전')
    assert.equal(createTranslator('xx')('time.now'), 'just now')
    assert.equal(createTranslator('en')('stage.check', {}), 'Check: {command}')
  })
})
