import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The terminal look a user picked in Orca, so the Studio renders the same way. */
export type TerminalAppearance = {
  fontFamily: string
  fontSize: number
  fontWeight: number
  fontWeightBold: number
  lineHeight: number
  themeDark: string
  themeLight: string
}

// Orca's own defaults: shared/default-global-settings.ts, terminal-fonts.ts, terminal-platform-defaults.ts.
export function orcaDefaultAppearance(platform: NodeJS.Platform = process.platform): TerminalAppearance {
  return {
    fontFamily: platform === 'win32' ? 'Cascadia Mono' : platform === 'linux' ? 'DejaVu Sans Mono' : 'SF Mono',
    fontSize: 14,
    fontWeight: 500,
    fontWeightBold: 700,
    lineHeight: 1,
    themeDark: 'Ghostty Default Style Dark',
    themeLight: 'Builtin Tango Light'
  }
}

function orcaUserDataDir(home: string, platform: NodeJS.Platform): string {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'orca')
  if (platform === 'win32') return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'orca')
  return join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'orca')
}

async function readJson(path: string): Promise<Record<string, any> | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

/** Reads only the terminal appearance fields from Orca's active profile; anything missing keeps Orca's default. */
export async function readOrcaTerminalAppearance(
  home = homedir(),
  platform: NodeJS.Platform = process.platform
): Promise<TerminalAppearance> {
  const defaults = orcaDefaultAppearance(platform)
  const userData = orcaUserDataDir(home, platform)
  const index = await readJson(join(userData, 'orca-profile-index.json'))
  const profile = typeof index?.activeProfileId === 'string' ? index.activeProfileId : 'local-default'
  if (!/^[\w.-]+$/.test(profile)) return defaults
  const settings = (await readJson(join(userData, 'profiles', profile, 'orca-data.json')))?.settings ?? {}
  const text = (value: unknown, fallback: string): string =>
    typeof value === 'string' && value.trim() ? value.trim() : fallback
  const number = (value: unknown, fallback: number, min: number, max: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : fallback
  return {
    fontFamily: text(settings.terminalFontFamily, defaults.fontFamily),
    fontSize: number(settings.terminalFontSize, defaults.fontSize, 6, 48),
    fontWeight: number(settings.terminalFontWeight, defaults.fontWeight, 100, 900),
    fontWeightBold: number(settings.terminalFontWeightBold, defaults.fontWeightBold, 100, 900),
    lineHeight: number(settings.terminalLineHeight, defaults.lineHeight, 0.8, 3),
    themeDark: text(settings.terminalThemeDark, defaults.themeDark),
    themeLight: text(settings.terminalThemeLight, defaults.themeLight)
  }
}
