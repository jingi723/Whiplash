import assert from 'node:assert/strict'
import { it } from 'node:test'
import { addressTo } from './compose.js'

it('addresses plain text to the reply target, but keeps explicit mentions and commands', () => {
  assert.equal(addressTo('이어서 해줘', 'Claude'), '@Claude 이어서 해줘')
  assert.equal(addressTo('@리뷰어 봐줘', 'Claude'), '@리뷰어 봐줘')
  assert.equal(addressTo('/tempo @Claude 다시', 'Claude'), '/tempo @Claude 다시')
  assert.equal(addressTo('메일은 me@Claude.com 으로', 'Claude'), '@Claude 메일은 me@Claude.com 으로')
  assert.equal(addressTo('`@리뷰어` 표기 고쳐', 'Claude'), '@Claude `@리뷰어` 표기 고쳐')
  assert.equal(addressTo('대상 없음', null), '대상 없음')
})
