import { browserBin } from './browser.ts'
import { serverPort } from './store.ts'

/** Markers a parent agent session leaves in its children; inherited, they make a CLI think it is a sub-session.
 *  Orca's list (main/ipc/pty/host-env/spawn-env-keys.ts) plus the session-bound keys seen in a Claude Code shell. */
const SESSION_MARKERS = new Set([
  'AI_AGENT',
  'CLAUDECODE',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_EFFORT',
  'CLAUDE_PID',
  // The desktop app runs the server on Electron as Node; inherited, it makes every Electron app an agent
  // launches (the Whiplash app itself included) start as bare Node and exit.
  'ELECTRON_RUN_AS_NODE'
])

/** The environment an agent starts with when Whiplash itself was launched from inside Claude Code or Orca. */
export function agentEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(([name]) => !SESSION_MARKERS.has(name) && !name.startsWith('ORCA_'))
  )
}

/** An agent's own environment: its `agent-browser` wrapper first on PATH, and who and where it is. */
export function memberEnv(memberId: string): NodeJS.ProcessEnv {
  const env = agentEnv()
  return {
    ...env,
    PATH: `${browserBin}:${env.PATH ?? ''}`,
    WHIPLASH_MEMBER_ID: memberId,
    WHIPLASH_URL: `http://127.0.0.1:${serverPort}`
  }
}
