import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { State } from './model.ts'

export const whiplashHome = process.env.WHIPLASH_HOME ?? join(homedir(), '.whiplash')
const SAVE_DELAY_MS = 300

export function loadState(home = whiplashHome): State {
  const path = join(home, 'state.json')
  if (!existsSync(path)) {
    return { channels: [] }
  }
  try {
    const state = JSON.parse(readFileSync(path, 'utf8')) as State
    return Array.isArray(state.channels) ? state : { channels: [] }
  } catch {
    // Keep the unreadable log aside so the next save cannot destroy it.
    renameSync(path, `${path}.corrupt-${Date.now()}`)
    return { channels: [] }
  }
}

function writeState(state: State, home: string): void {
  mkdirSync(home, { recursive: true })
  const path = join(home, 'state.json')
  const temporary = `${path}.${randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify(state))
  renameSync(temporary, path)
}

export function createSaver(state: State, home = whiplashHome) {
  let timer: NodeJS.Timeout | null = null
  return {
    schedule(): void {
      timer ??= setTimeout(() => {
        timer = null
        writeState(state, home)
      }, SAVE_DELAY_MS)
    },
    flush(): void {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      writeState(state, home)
    }
  }
}
