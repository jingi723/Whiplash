import assert from 'node:assert/strict'
import { it } from 'node:test'
import { claudePlan, decodeJwtPayload } from './accounts.ts'

it('names the Claude plan from its rate-limit tier', () => {
  assert.equal(claudePlan({ organizationRateLimitTier: 'default_claude_max_20x' }), 'Max 20x')
  assert.equal(claudePlan({ organizationType: 'claude_pro' }), 'Pro')
  assert.equal(claudePlan({}), undefined)
})

it('reads JWT claims and tolerates garbage', () => {
  const token = `x.${Buffer.from(JSON.stringify({ email: 'a@b.c' })).toString('base64url')}.y`
  assert.equal(decodeJwtPayload(token)?.email, 'a@b.c')
  assert.equal(decodeJwtPayload('nope'), null)
})
