import assert from 'node:assert/strict'
import { it } from 'node:test'
import { agentEnv } from './env.ts'

it('drops parent session markers but keeps user settings', () => {
  assert.deepEqual(
    agentEnv({
      PATH: '/bin',
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: 'parent',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_BRIDGE_SESSION_ID: 'bridge',
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      ORCA_PANE_KEY: 'pane',
      ORCA_AGENT_HOOK_TOKEN: 'secret',
      ELECTRON_RUN_AS_NODE: '1'
    }),
    { PATH: '/bin', CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' }
  )
})
