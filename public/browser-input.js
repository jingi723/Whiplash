// The owner's mouse and keys, turned into CDP Input events for the agent's Chrome.

/** A point on the shown frame (client coordinates over its box) as a page point in CSS pixels. */
export function pagePoint(clientX, clientY, rect, metadata) {
  const scale = metadata.pageScaleFactor || 1
  const x = ((clientX - rect.left) / rect.width) * metadata.deviceWidth
  const y = ((clientY - rect.top) / rect.height) * metadata.deviceHeight - (metadata.offsetTop || 0)
  return { x: Math.round(x / scale), y: Math.round(y / scale) }
}

/** CDP's bits: Alt 1, Ctrl 2, Meta 4, Shift 8. */
export const modifiersOf = (event) => (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0)

const NAMED_KEYS = new Set(['Enter', 'Backspace', 'Tab', 'Escape', 'Delete', 'Home', 'End', 'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'])
/** ⌘ shortcuts headless Chrome on a Mac only follows as editing commands. ⌘C/X/V stay with the viewer's clipboard. */
const MAC_COMMANDS = { a: 'selectAll', z: 'undo' }

/**
 * The Input.dispatchKeyEvent pair for a key that is not text, or [] to let it arrive as text
 * (insertText from the input and composition events, so Hangul composes whole).
 */
export function cdpKeyEvents(event) {
  let commands
  if (event.metaKey) {
    const command = MAC_COMMANDS[event.key.toLowerCase()]
    if (!command) return []
    commands = [command === 'undo' && event.shiftKey ? 'redo' : command]
  } else if (!NAMED_KEYS.has(event.key) && !(event.ctrlKey && event.key.length === 1)) {
    return []
  }
  const base = { key: event.key, code: event.code, windowsVirtualKeyCode: event.keyCode, nativeVirtualKeyCode: event.keyCode, modifiers: modifiersOf(event) }
  // Enter's default (a newline, a form submit) needs the char a plain keyDown carries.
  const down = event.key === 'Enter' ? { type: 'keyDown', text: '\r' } : { type: 'rawKeyDown' }
  return [{ ...base, ...down, ...(commands ? { commands } : {}) }, { ...base, type: 'keyUp' }]
}

/** What the address bar typed means: a URL as is, a bare host as https; a host:port is not a scheme. */
export function addressUrl(text) {
  const value = text.trim()
  if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(value)) return value
  return `${/^(localhost|127\.0\.0\.1)(:|\/|$)/.test(value) ? 'http' : 'https'}://${value}`
}
