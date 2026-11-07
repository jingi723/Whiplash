import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'
import { orcaDefaultAppearance, readOrcaTerminalAppearance } from './orca-appearance.ts'

it("reads the active Orca profile's terminal look and keeps defaults for missing or bad values", async () => {
  const home = mkdtempSync(join(tmpdir(), 'whiplash-orca-'))
  assert.deepEqual(await readOrcaTerminalAppearance(home, 'darwin'), orcaDefaultAppearance('darwin'))
  const userData = join(home, 'Library', 'Application Support', 'orca')
  mkdirSync(join(userData, 'profiles', 'work'), { recursive: true })
  writeFileSync(join(userData, 'orca-profile-index.json'), JSON.stringify({ activeProfileId: 'work' }))
  writeFileSync(
    join(userData, 'profiles', 'work', 'orca-data.json'),
    JSON.stringify({ settings: { terminalFontFamily: 'JetBrains Mono', terminalFontSize: 13, terminalLineHeight: 99, terminalThemeDark: 'Dracula' } })
  )
  assert.deepEqual(await readOrcaTerminalAppearance(home, 'darwin'), {
    ...orcaDefaultAppearance('darwin'),
    fontFamily: 'JetBrains Mono',
    fontSize: 13,
    themeDark: 'Dracula'
  })
})
