import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { codexPrompts, expandCodexPrompt } from './models.ts'

describe('codex prompts', () => {
  it('lists custom prompts and sends a file body with its arguments', async () => {
    const home = mkdtempSync(join(tmpdir(), 'whiplash-codex-'))
    mkdirSync(join(home, '.codex', 'prompts'), { recursive: true })
    writeFileSync(join(home, '.codex', 'prompts', 'check.md'), '---\ndescription: x\n---\n\n대상: $ARGUMENTS\n')
    assert.deepEqual(codexPrompts(home), ['prompts:check'])
    assert.equal(await expandCodexPrompt('prompts:check', 'src/a.ts', home), '대상: src/a.ts')
    assert.equal(await expandCodexPrompt('status', '', home), '/status')
  })
})
