// Adapted from Orca (MIT, Copyright (c) 2026 Lovecast Inc.)
// src/shared/terminal/protocol/input-modes/terminal-modified-enter-encoding.ts (encodeTerminalShiftEnter) and
// src/renderer/src/components/terminal-pane/input/keyboard/terminal-shortcut-policy.ts (Shift+Enter branch) @ stablyai/orca 0069492b
// Changes: xterm 6.0.0 has no kitty keyboard protocol and Whiplash doesn't track modifyOtherKeys, so only the
// ESC CR fallback is kept — the same bytes Claude Code's /terminal-setup binds Shift+Enter to.

export const TERMINAL_SHIFT_ENTER_INPUT = '\x1b\r'

/** Bare Shift+Enter (no IME composition): the CLIs read ESC CR as "insert a newline", while xterm would send a plain CR (submit). */
export const isShiftEnter = (event) =>
  event.key === 'Enter' && event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey && !event.isComposing
