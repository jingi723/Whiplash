import { execFile } from 'node:child_process'
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** A phone or browser paired over Tailscale. Only the token's hash is kept; the device holds the token in a cookie. */
export type Device = { id: string; name: string; tokenHash: string; pairedAt: number; push: string[] }

export const DEVICE_COOKIE = 'whiplash_device'
const PAIR_CODE_MS = 10 * 60_000
const COOKIE_MAX_AGE_S = 400 * 24 * 3600

const hashOf = (token: string): string => createHash('sha256').update(token).digest('hex')

function writePrivate(path: string, data: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, data, { mode: 0o600 })
}

export function createDevices(home: string) {
  const path = join(home, 'devices.json')
  const devices: Device[] = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : []
  // One live code at a time: minting a new one retires the last.
  let pairing: { code: string; expiresAt: number } | null = null
  const save = (): void => writePrivate(path, JSON.stringify(devices, null, 2))

  return {
    list: (): Device[] => devices,
    newCode(now = Date.now()): string {
      pairing = { code: randomBytes(6).toString('hex'), expiresAt: now + PAIR_CODE_MS }
      return pairing.code
    },
    /** Trades a live code for a device token, once. */
    redeem(code: string, name: string, now = Date.now()): string | null {
      if (!pairing || pairing.code !== code || now > pairing.expiresAt) return null
      pairing = null
      const token = randomBytes(32).toString('base64url')
      devices.push({ id: randomUUID(), name, tokenHash: hashOf(token), pairedAt: now, push: [] })
      save()
      return token
    },
    fromCookie(cookie = ''): Device | undefined {
      const token = new RegExp(`(?:^|;\\s*)${DEVICE_COOKIE}=([^;]+)`).exec(cookie)?.[1]
      if (!token) return undefined
      const hash = hashOf(token)
      return devices.find(({ tokenHash }) => tokenHash === hash)
    },
    revoke(id: string): boolean {
      const index = devices.findIndex((device) => device.id === id)
      if (index < 0) return false
      devices.splice(index, 1)
      save()
      return true
    },
    addPush(device: Device, endpoint: string): void {
      if (!device.push.includes(endpoint)) device.push.push(endpoint)
      save()
    },
    dropPush(endpoint: string): void {
      for (const device of devices) device.push = device.push.filter((one) => one !== endpoint)
      save()
    }
  }
}

export const deviceCookie = (token: string): string =>
  `${DEVICE_COOKIE}=${token}; Path=/; Max-Age=${COOKIE_MAX_AGE_S}; HttpOnly; Secure; SameSite=Strict`

/** A short label from the user agent, enough to tell devices apart in the list. */
export const deviceName = (userAgent = ''): string =>
  /iPhone|iPad|Android|Macintosh|Windows|Linux/.exec(userAgent)?.[0].replace('Macintosh', 'Mac') ?? 'Browser'

export type VapidKeys = { publicKey: string; privateKey: string }

/** VAPID keys for Web Push, made once with node crypto and kept beside the devices. */
export function vapidKeys(home: string): VapidKeys {
  const path = join(home, 'vapid.json')
  if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'))
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = pair.publicKey.export({ format: 'jwk' })
  const keys = {
    // The browser wants the uncompressed point: 0x04 || x || y.
    publicKey: Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')]).toString('base64url'),
    privateKey: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
  }
  writePrivate(path, JSON.stringify(keys))
  return keys
}

export function vapidJwt(endpoint: string, privateKey: string, now = Date.now()): string {
  const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  const claims = { aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: 'mailto:whiplash@example.com' }
  const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part(claims)}`
  return `${unsigned}.${sign('sha256', Buffer.from(unsigned), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`
}

/**
 * A push with no payload, so no message encryption: the service worker shows a generic notice.
 * Resolves to the push service's status; 404 and 410 mean the subscription is gone.
 */
export async function sendPush(endpoint: string, keys: VapidKeys): Promise<number> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { authorization: `vapid t=${vapidJwt(endpoint, keys.privateKey)}, k=${keys.publicKey}`, ttl: '86400', urgency: 'high' }
  })
  return response.status
}

const TAILSCALE_CLIS = ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']

/** This Mac's tailnet name (e.g. mac.tail1234.ts.net), or null without Tailscale. */
export async function tailscaleHost(): Promise<string | null> {
  for (const cli of TAILSCALE_CLIS) {
    const out = await new Promise<string | null>((done) =>
      execFile(cli, ['status', '--json'], { timeout: 3000 }, (error, stdout) => done(error ? null : stdout))
    )
    if (!out) continue
    try {
      const name = JSON.parse(out).Self?.DNSName
      if (typeof name === 'string' && name) return name.replace(/\.$/, '')
    } catch {}
  }
  return null
}
