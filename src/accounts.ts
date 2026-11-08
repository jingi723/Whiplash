// Which account each CLI is signed in with, read from the CLIs' own local files. Nothing is sent anywhere.
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type Account = { signedIn: boolean; email?: string; plan?: string }

const readJson = async (path: string): Promise<any> => JSON.parse(await readFile(path, 'utf8').catch(() => 'null'))

export function decodeJwtPayload(token: string | undefined): Record<string, any> | null {
  const part = token?.split('.')[1]
  if (!part) return null
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
  } catch {
    return null
  }
}

export async function claudeAccount(): Promise<Account> {
  const dir = process.env.CLAUDE_CONFIG_DIR
  const config = await readJson(dir ? join(dir, '.claude.json') : join(homedir(), '.claude.json'))
  const account = config?.oauthAccount
  if (!account?.emailAddress) return { signedIn: false }
  return { signedIn: true, email: account.emailAddress, plan: account.planDisplayName ?? claudePlan(account) }
}

/** 'default_claude_max_20x' reads as 'Max 20x'; 'claude_pro' as 'Pro'. */
export function claudePlan(account: { organizationRateLimitTier?: string; organizationType?: string }): string | undefined {
  const match = /claude_([a-z]+)(?:_(\d+x))?$/.exec(account.organizationRateLimitTier ?? account.organizationType ?? '')
  if (!match) return undefined
  const name = match[1][0].toUpperCase() + match[1].slice(1)
  return match[2] ? `${name} ${match[2]}` : name
}

export async function codexAccount(): Promise<Account> {
  const auth = await readJson(join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json'))
  if (!auth?.tokens?.access_token) return { signedIn: Boolean(auth?.OPENAI_API_KEY), plan: auth?.OPENAI_API_KEY ? 'API key' : undefined }
  const claims = decodeJwtPayload(auth.tokens.id_token)
  return { signedIn: true, email: claims?.email, plan: claims?.['https://api.openai.com/auth']?.chatgpt_plan_type }
}
