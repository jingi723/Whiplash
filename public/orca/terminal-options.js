// Adapted from Orca (MIT, Copyright (c) 2026 Lovecast Inc.)
// src/renderer/src/lib/pane-manager/pane-terminal-options.ts @ stablyai/orca 0069492b
// Changes: options xterm 6.0.0 lacks (vtExtensions, scrollbar) dropped; scrollback fixed. The Studio replaces the
// font and theme with the user's Orca settings, as Orca's applyTerminalAppearance does.

export const DEFAULT_TERMINAL_SCROLL_SENSITIVITY = 1.15
export const DEFAULT_TERMINAL_FAST_SCROLL_SENSITIVITY = 5
const SCROLLBACK_ROWS = 5000

export function buildDefaultTerminalOptions() {
  const cursorStyle = 'block'
  return {
    allowProposedApi: true,
    cursorBlink: true,
    cursorStyle,
    // Inactive outline adds unwanted strokes to bar/underline cursors; reserve it for block cursors.
    cursorInactiveStyle: 'outline',
    fontSize: 14,
    // Cross-platform fallback chain; keep in sync with FALLBACK_FONTS in layout-serialization.ts.
    fontFamily:
      '"SF Mono", "Menlo", "Monaco", "Cascadia Mono", "Consolas", "DejaVu Sans Mono", "Liberation Mono", "Symbols Nerd Font Mono", "MesloLGS Nerd Font", "JetBrainsMono Nerd Font", "Hack Nerd Font", monospace',
    fontWeight: '300',
    fontWeightBold: '500',
    scrollback: SCROLLBACK_ROWS,
    // A small wheel multiplier offsets Orca's taller default terminal cells.
    scrollSensitivity: DEFAULT_TERMINAL_SCROLL_SENSITIVITY,
    fastScrollSensitivity: DEFAULT_TERMINAL_FAST_SCROLL_SENSITIVITY,
    scrollOnUserInput: true,
    allowTransparency: false,
    // Why: on macOS, non-US layouts rely on Option to compose characters like @ and €.
    macOptionIsMeta: false,
    macOptionClickForcesSelection: true,
    drawBoldTextInBrightColors: true
  }
}
