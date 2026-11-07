// Adapted from Orca (MIT, Copyright (c) 2026 Lovecast Inc.)
// src/shared/terminal/appearance/terminal-unicode-provider.ts @ stablyai/orca 0069492b
// Changes: TypeScript types removed.

const ORCA_UNICODE_VERSION = 'orca-11-zwj'
const UNICODE11_VERSION = '11'
const ZERO_WIDTH_JOINER = 0x200d

function extractWidth(properties) {
  return (properties >> 1) & 3
}

function extractCharKind(properties) {
  return properties >> 3
}

function createProperties(charKind, width, shouldJoin) {
  return ((charKind & 0xffffff) << 3) | ((width & 3) << 1) | (shouldJoin ? 1 : 0)
}

class OrcaUnicodeProvider {
  version = ORCA_UNICODE_VERSION

  constructor(baseProvider) {
    this.baseProvider = baseProvider
  }

  wcwidth(codepoint) {
    return this.baseProvider.wcwidth(codepoint)
  }

  charProperties(codepoint, preceding) {
    const precedingWidth = extractWidth(preceding)
    const precedingKind = extractCharKind(preceding)

    if (codepoint === ZERO_WIDTH_JOINER && precedingWidth > 0) {
      return createProperties(ZERO_WIDTH_JOINER, precedingWidth, true)
    }

    if (precedingKind === ZERO_WIDTH_JOINER && precedingWidth > 0 && this.wcwidth(codepoint) > 0) {
      // CLIs budget ZWJ emoji as one wide glyph; Unicode11 otherwise advances for both emoji parts.
      return createProperties(codepoint, precedingWidth, true)
    }

    return this.baseProvider.charProperties(codepoint, preceding)
  }
}

export function activateOrcaTerminalUnicodeProvider(terminal) {
  const { unicode } = terminal
  if (unicode.activeVersion === ORCA_UNICODE_VERSION) {
    return
  }

  const baseProvider = terminal._core?.unicodeService?._providers?.[UNICODE11_VERSION]
  if (!baseProvider) {
    unicode.activeVersion = UNICODE11_VERSION
    return
  }

  if (!unicode.versions.includes(ORCA_UNICODE_VERSION)) {
    unicode.register(new OrcaUnicodeProvider(baseProvider))
  }
  unicode.activeVersion = ORCA_UNICODE_VERSION
}
