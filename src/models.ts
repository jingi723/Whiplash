import { readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type ModelChoice = { id: string; label: string; efforts: string[] }
export type ModelList = { models: ModelChoice[]; model?: string; effort?: string }

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
// ponytail: Claude Code has no model listing to read; update with new releases.
const CLAUDE_MODELS: ModelChoice[] = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5', efforts: CLAUDE_EFFORTS },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', efforts: CLAUDE_EFFORTS },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5', efforts: CLAUDE_EFFORTS },
  { id: 'claude-fable-5-1', label: 'Fable 5.1', efforts: CLAUDE_EFFORTS }
]

const readText = (path: string): Promise<string> => readFile(path, 'utf8').catch(() => '')

async function claudeModels(home: string): Promise<ModelList> {
  let settings: { model?: string; effortLevel?: string } = {}
  try {
    settings = JSON.parse(await readText(join(home, '.claude', 'settings.json')))
  } catch {}
  return { models: CLAUDE_MODELS, model: settings.model, effort: settings.effortLevel }
}

/** Codex keeps the list it shows in `/model` in a cache file; hidden entries are internal. */
async function codexModels(home: string): Promise<ModelList> {
  let models: ModelChoice[] = []
  try {
    const cache = JSON.parse(await readText(join(home, '.codex', 'models_cache.json')))
    models = (cache.models ?? [])
      .filter((model: { visibility?: string }) => model.visibility !== 'hide')
      .map((model: { slug: string; display_name?: string; supported_reasoning_levels?: { effort: string }[] }) => ({
        id: model.slug,
        label: model.display_name ?? model.slug,
        efforts: (model.supported_reasoning_levels ?? []).map(({ effort }) => effort)
      }))
  } catch {}
  const config = await readText(join(home, '.codex', 'config.toml'))
  const value = (key: string) => new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm').exec(config)?.[1]
  return { models, model: value('model'), effort: value('model_reasoning_effort') }
}

export async function listModels(home = homedir()): Promise<{ claude: ModelList; codex: ModelList }> {
  const [claude, codex] = await Promise.all([claudeModels(home), codexModels(home)])
  return { claude, codex }
}

const codexPromptDir = (home: string) => join(home, '.codex', 'prompts')

/** Codex lists no commands, but its custom ones are files the master wrote, run as `/prompts:<file name>`. */
export function codexPrompts(home = homedir()): string[] {
  try {
    return readdirSync(codexPromptDir(home))
      .filter((file) => file.endsWith('.md'))
      .map((file) => `prompts:${file.slice(0, -3)}`)
  } catch {
    return []
  }
}

/** `codex exec` takes no slash commands, so a custom one is sent as the prompt its file holds, as the TUI would. */
export async function expandCodexPrompt(command: string, args: string, home = homedir()): Promise<string> {
  const name = command.replace(/^prompts:/, '')
  if (!codexPrompts(home).includes(command)) return `/${command} ${args}`.trim()
  const body = (await readText(join(codexPromptDir(home), `${name}.md`))).replace(/^---\n[\s\S]*?\n---\n/, '')
  // ponytail: only $ARGUMENTS is filled; add $1..$9 and KEY=value when a prompt uses them.
  return body.replaceAll('$ARGUMENTS', args).trim()
}
