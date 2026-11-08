// Adapted from Orca (MIT, Copyright (c) 2026 Lovecast Inc.)
// src/shared/rate-limit-window-label.ts @ stablyai/orca 0069492b
// Changes: TypeScript types removed.

import { formatResetDuration } from './rate-limit-reset-format.js'

/** Format usage-window duration; retain 10080 minutes → wk compatibility with the original status bar. */
export function formatWindowLabel(windowMinutes) {
  if (windowMinutes === 10080) {
    return 'wk'
  }
  if (windowMinutes === 300) {
    return '5h'
  }
  if (windowMinutes === 60) {
    return '1h'
  }
  if (windowMinutes < 60) {
    return `${windowMinutes}m`
  }
  if (windowMinutes % (60 * 24 * 7) === 0) {
    return `${windowMinutes / (60 * 24 * 7)}wk`
  }
  if (windowMinutes % (60 * 24) === 0) {
    return `${windowMinutes / (60 * 24)}d`
  }
  if (windowMinutes % 60 === 0) {
    return `${windowMinutes / 60}h`
  }
  return `${windowMinutes}m`
}

/** Match popup remaining-time labels when resetsAt exists (#8378); otherwise use fixed window duration. */
export function formatRateLimitWindowChipLabel(
  window,
  now = Date.now()
) {
  if (window.resetsAt != null) {
    return formatResetDuration(window.resetsAt - now)
  }
  return formatWindowLabel(window.windowMinutes)
}
