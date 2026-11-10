// Adapted from Orca (MIT, Copyright (c) 2026 Lovecast Inc.)
// src/renderer/src/components/floating-terminal/floating-terminal-panel-bounds.ts (defaults, clamp, maximize),
// floating-terminal-panel-drag-actions.ts, FloatingTerminalResizeHandles.tsx and
// use-floating-terminal-panel-maximize.ts @ stablyai/orca efeee83b
// Changes: plain DOM instead of React; one localStorage record holds bounds, open and maximized.
// ponytail: bounds are stored as absolute left/top, not Orca's corner anchors, so a much larger window
// keeps the panel where it was instead of hugging its corner; add anchors if that bothers anyone.

export const MIN_WIDTH = 420
export const MIN_HEIGHT = 280
const DEFAULT_WIDTH = 920
const DEFAULT_HEIGHT = 560
const RIGHT_GAP = 24
const BOTTOM_GAP = 84
const SAFE_TOP = 36
const EDGE = 8
const MAX_MARGIN = 12
const MAX_BOTTOM_GAP = 36
const EDGES = ['n', 's', 'w', 'e', 'nw', 'ne', 'sw', 'se']

const clamp = (value, min, max) => Math.min(Math.max(min, value), max)

/** Bottom-right, clear of the titlebar. */
export function defaultBounds({ width: vw, height: vh }) {
  const width = Math.min(DEFAULT_WIDTH, Math.max(MIN_WIDTH, vw - 48))
  const height = Math.min(DEFAULT_HEIGHT, Math.max(MIN_HEIGHT, vh - 96))
  return { left: Math.max(16, vw - width - RIGHT_GAP), top: Math.max(SAFE_TOP, vh - height - BOTTOM_GAP), width, height }
}

/** Keeps the panel at least its minimum size and inside the window. */
export function clampBounds(bounds, { width: vw, height: vh }) {
  const width = Math.max(MIN_WIDTH, Math.min(bounds.width, Math.max(MIN_WIDTH, vw - EDGE * 2)))
  const height = Math.max(MIN_HEIGHT, Math.min(bounds.height, Math.max(MIN_HEIGHT, vh - SAFE_TOP - EDGE)))
  return {
    left: clamp(bounds.left, EDGE, Math.max(EDGE, vw - width - EDGE)),
    top: clamp(bounds.top, SAFE_TOP, Math.max(SAFE_TOP, vh - height - EDGE)),
    width,
    height
  }
}

export function maximizedBounds({ width: vw, height: vh }) {
  return { left: MAX_MARGIN, top: SAFE_TOP, width: Math.max(MIN_WIDTH, vw - MAX_MARGIN * 2), height: Math.max(MIN_HEIGHT, vh - SAFE_TOP - MAX_BOTTOM_GAP) }
}

/** Moves the dragged edge(s); a west or north edge stops at the minimum instead of pushing the far side. */
export function resizeBounds(start, edge, dx, dy) {
  const next = { ...start }
  if (edge.includes('e')) next.width = start.width + dx
  if (edge.includes('s')) next.height = start.height + dy
  if (edge.includes('w')) Object.assign(next, { left: start.left + dx, width: start.width - dx })
  if (edge.includes('n')) Object.assign(next, { top: start.top + dy, height: start.height - dy })
  if (next.width < MIN_WIDTH && edge.includes('w')) next.left = start.left + start.width - MIN_WIDTH
  if (next.height < MIN_HEIGHT && edge.includes('n')) next.top = start.top + start.height - MIN_HEIGHT
  return next
}

export function parseState(serialized) {
  try {
    const { bounds, open, maximized } = JSON.parse(serialized) ?? {}
    const valid = bounds && ['left', 'top', 'width', 'height'].every((key) => Number.isFinite(bounds[key]))
    return { bounds: valid ? bounds : null, open: open === true, maximized: maximized === true }
  } catch {
    return { bounds: null, open: false, maximized: false }
  }
}

/** A fixed window above the app: fill `bar` and `body`; drag the bar, resize from any edge, double-click to maximize. */
export function mountFloatingPanel({ h, storageKey }) {
  const viewport = () => ({ width: innerWidth, height: innerHeight })
  let state = { bounds: null, open: false, maximized: false }
  try {
    state = parseState(localStorage.getItem(storageKey))
  } catch {}
  const bar = h('div', { class: 'floating-titlebar' })
  const body = h('div', { class: 'floating-body' })
  const handles = EDGES.map((edge) => h('div', { class: `floating-resize ${edge}`, 'data-edge': edge }))
  const node = h('div', { class: 'floating-panel', hidden: !state.open }, bar, body, ...handles)

  const rect = () => (state.maximized ? maximizedBounds(viewport()) : clampBounds(state.bounds ?? defaultBounds(viewport()), viewport()))
  const save = () => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(state))
    } catch {}
  }
  function place() {
    const { left, top, width, height } = rect()
    Object.assign(node.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` })
    node.classList.toggle('maximized', state.maximized)
  }
  const onControl = (event) => event.target.closest('button, select, input')

  // One pointer-capture gesture from `target`: `next` turns the start rect and the pointer's travel into bounds.
  function track(target, allowed, next) {
    target.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || !allowed(event)) return
      event.preventDefault()
      event.stopPropagation()
      const start = rect()
      const { clientX, clientY, pointerId } = event
      let moved = false
      try {
        target.setPointerCapture(pointerId)
      } catch {}
      const move = (e) => {
        if (e.pointerId !== pointerId) return
        moved = true
        state.bounds = clampBounds(next(start, e.clientX - clientX, e.clientY - clientY), viewport())
        place()
      }
      const end = (e) => {
        if (e.pointerId !== pointerId) return
        for (const [type, listener] of listeners) target.removeEventListener(type, listener)
        if (moved) save()
      }
      const listeners = [['pointermove', move], ['pointerup', end], ['pointercancel', end]]
      for (const [type, listener] of listeners) target.addEventListener(type, listener)
    })
  }
  track(bar, (event) => !state.maximized && !onControl(event), (start, dx, dy) => ({ ...start, left: start.left + dx, top: start.top + dy }))
  for (const handle of handles) track(handle, () => !state.maximized, (start, dx, dy) => resizeBounds(start, handle.dataset.edge, dx, dy))
  bar.addEventListener('dblclick', (event) => {
    if (!onControl(event)) toggleMaximized()
  })
  addEventListener('resize', place)
  place()

  function setOpen(open) {
    state.open = open
    node.hidden = !open
    if (open) place()
    save()
  }
  function toggleMaximized() {
    state.maximized = !state.maximized
    place()
    save()
  }
  return {
    node,
    bar,
    body,
    setOpen,
    toggleMaximized,
    get open() {
      return state.open
    },
    get maximized() {
      return state.maximized
    }
  }
}
