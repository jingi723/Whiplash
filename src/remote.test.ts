import assert from 'node:assert/strict'
import { createPublicKey, verify } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'
import { createDevices, DEVICE_COOKIE, vapidJwt, vapidKeys } from './remote.ts'

it('pairs a device once, finds it by cookie, and forgets it on revoke', () => {
  const home = mkdtempSync(join(tmpdir(), 'whiplash-remote-'))
  const devices = createDevices(home)
  const code = devices.newCode(0)
  assert.equal(devices.redeem('wrong', 'iPhone', 0), null)
  assert.equal(devices.redeem(code, 'iPhone', 11 * 60_000), null, 'expired')
  const fresh = devices.newCode(0)
  const token = devices.redeem(fresh, 'iPhone', 1000)
  assert.ok(token)
  assert.equal(devices.redeem(fresh, 'iPhone', 1000), null, 'one-time')
  const device = devices.fromCookie(`a=b; ${DEVICE_COOKIE}=${token}`)
  assert.equal(device?.name, 'iPhone')
  assert.ok(!JSON.stringify(createDevices(home).list()).includes(token!), 'only the hash is stored')
  assert.equal(createDevices(home).fromCookie(`${DEVICE_COOKIE}=${token}`)?.id, device!.id)
  assert.equal(devices.fromCookie(`${DEVICE_COOKIE}=nope`), undefined)
  devices.revoke(device!.id)
  assert.equal(devices.fromCookie(`${DEVICE_COOKIE}=${token}`), undefined)
})

it('signs a VAPID JWT the push service can check with the public key', () => {
  const home = mkdtempSync(join(tmpdir(), 'whiplash-vapid-'))
  const keys = vapidKeys(home)
  assert.deepEqual(vapidKeys(home), keys, 'kept across restarts')
  const [header, claims, signature] = vapidJwt('https://web.push.apple.com/abc', keys.privateKey, 0).split('.')
  assert.equal(JSON.parse(Buffer.from(claims, 'base64url').toString()).aud, 'https://web.push.apple.com')
  const point = Buffer.from(keys.publicKey, 'base64url')
  const publicKey = createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') },
    format: 'jwk'
  })
  const ok = verify('sha256', Buffer.from(`${header}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))
  assert.ok(ok)
})
