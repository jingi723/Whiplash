// Plan limits for Claude and Codex, read the way Orca reads them (src/main/rate-limits).
// Tokens never leave this process except to each provider's own usage endpoint.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { mapClaudeUsageWindow, type ClaudeUsageWindowInput } from './orca/rate-limits/claude-usage-window.ts'
import {
  classifyCodexRateLimitWindows,
  CODEX_SESSION_WINDOW_MINUTES,
  CODEX_WEEKLY_WINDOW_MINUTES,
  type CodexRateWindowSnapshot
} from './orca/rate-limits/codex-rate-limit-window-classification.ts'
import { mapCodexRateLimitWindow } from './orca/rate-limits/codex-rate-limit-window-mapper.ts'
import type { RateLimitWindow } from './orca/rate-limits/rate-limit-types.ts'

export type ProviderUsage = {
  session: RateLimitWindow | null
  weekly: RateLimitWindow | null
  /** Why nothing could be read: not signed in, or the request failed. */
  error?: 'signedOut' | 'unavailable'
}
export type Usage = { claude: ProviderUsage; codex: ProviderUsage; updatedAt: number }

const TIMEOUT_MS = 10_000
const CACHE_MS = 60_000
const run = promisify(execFile)

// From Orca's claude-accounts/keychain.ts: Claude 2.1+ names its item after CLAUDE_CONFIG_DIR when set.
function claudeKeychainService(configDir?: string): string {
  const base = 'Claude Code-credentials'
  return configDir
    ? `${base}-${createHash('sha256').update(configDir.normalize('NFC')).digest('hex').slice(0, 8)}`
    : base
}

function keychainUser(): string {
  let user: string
  try {
    user = process.env.USER || process.env.USERNAME || userInfo().username
  } catch {
    return 'claude-code-user'
  }
  return /^[a-zA-Z0-9._-]+$/.test(user) ? user : 'claude-code-user'
}

/** Orca's readClaudeOAuthCredentials order: the macOS keychain, then ~/.claude/.credentials.json. */
async function readClaudeToken(): Promise<string | null> {
  const parse = (raw: string): string | null => {
    try {
      return JSON.parse(raw)?.claudeAiOauth?.accessToken || null
    } catch {
      return null
    }
  }
  if (process.platform === 'darwin') {
    const service = claudeKeychainService(process.env.CLAUDE_CONFIG_DIR)
    const fromKeychain = await run('security', ['find-generic-password', '-s', service, '-a', keychainUser(), '-w'], {
      timeout: TIMEOUT_MS
    }).then(
      ({ stdout }) => parse(stdout.trim()),
      () => null
    )
    if (fromKeychain) return fromKeychain
  }
  const dir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  return parse(await readFile(join(dir, '.credentials.json'), 'utf8').catch(() => ''))
}

type ClaudeUsageResponse = { five_hour?: ClaudeUsageWindowInput; seven_day?: ClaudeUsageWindowInput }

// Request shape from Orca's claude-oauth-usage-request.ts.
export async function fetchClaudeUsage(fetcher: typeof fetch = fetch): Promise<ProviderUsage> {
  const token = await readClaudeToken()
  if (!token) return { session: null, weekly: null, error: 'signedOut' }
  try {
    const response = await fetcher('https://api.anthropic.com/api/oauth/usage', {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'claude-code/2.1.0' },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    if (!response.ok) return { session: null, weekly: null, error: response.status === 401 ? 'signedOut' : 'unavailable' }
    const data = (await response.json()) as ClaudeUsageResponse
    return { session: mapClaudeUsageWindow(data.five_hour, 300), weekly: mapClaudeUsageWindow(data.seven_day, 10080) }
  } catch {
    return { session: null, weekly: null, error: 'unavailable' }
  }
}

type BackendWindow = { used_percent?: number; limit_window_seconds?: number; reset_at?: number }
type CodexUsageResponse = {
  plan_type?: string
  rate_limit?: { primary_window?: BackendWindow | null; secondary_window?: BackendWindow | null } | null
}

function backendWindowToSnapshot(raw: BackendWindow | null | undefined): CodexRateWindowSnapshot | null {
  if (!raw) return null
  const seconds = raw.limit_window_seconds
  const windowDurationMins = typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds / 60) : undefined
  return { usedPercent: raw.used_percent, windowDurationMins, resetsAt: raw.reset_at }
}

// Request and mapping from Orca's codex-backend-auth.ts and codex-backend-usage-client.ts.
export async function fetchCodexUsage(fetcher: typeof fetch = fetch): Promise<ProviderUsage> {
  const home = process.env.CODEX_HOME ?? join(homedir(), '.codex')
  let tokens: { access_token?: string; account_id?: string } | undefined
  try {
    tokens = JSON.parse(await readFile(join(home, 'auth.json'), 'utf8'))?.tokens
  } catch {
    tokens = undefined
  }
  if (!tokens?.access_token) return { session: null, weekly: null, error: 'signedOut' }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${tokens.access_token}`,
    'User-Agent': 'codex-cli',
    'OpenAI-Beta': 'codex-1',
    originator: 'Codex Desktop',
    ...(tokens.account_id ? { 'ChatGPT-Account-Id': tokens.account_id } : {})
  }
  try {
    const response = await fetcher('https://chatgpt.com/backend-api/wham/usage', { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!response.ok) return { session: null, weekly: null, error: response.status === 401 ? 'signedOut' : 'unavailable' }
    const payload = (await response.json()) as CodexUsageResponse
    const classified = classifyCodexRateLimitWindows({
      primary: backendWindowToSnapshot(payload.rate_limit?.primary_window),
      secondary: backendWindowToSnapshot(payload.rate_limit?.secondary_window)
    })
    const minutes = (window: CodexRateWindowSnapshot | null, fallback: number): number =>
      typeof window?.windowDurationMins === 'number' && window.windowDurationMins > 0 ? window.windowDurationMins : fallback
    return {
      session: mapCodexRateLimitWindow(classified.session, minutes(classified.session, CODEX_SESSION_WINDOW_MINUTES)),
      weekly: mapCodexRateLimitWindow(classified.weekly, minutes(classified.weekly, CODEX_WEEKLY_WINDOW_MINUTES))
    }
  } catch {
    return { session: null, weekly: null, error: 'unavailable' }
  }
}

let cached: Usage | null = null
let inFlight: Promise<Usage> | null = null

/** Both providers at once, reused for a minute so every open tab does not hit the usage endpoints. */
export function readUsage(force = false): Promise<Usage> {
  if (!force && cached && Date.now() - cached.updatedAt < CACHE_MS) return Promise.resolve(cached)
  inFlight ??= Promise.all([fetchClaudeUsage(), fetchCodexUsage()])
    .then(([claude, codex]) => (cached = { claude, codex, updatedAt: Date.now() }))
    .finally(() => (inFlight = null))
  return inFlight
}
