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
  'CLAUDE_PID'
])

/** The environment an agent starts with when Whiplash itself was launched from inside Claude Code or Orca. */
export function agentEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(([name]) => !SESSION_MARKERS.has(name) && !name.startsWith('ORCA_'))
  )
}
