// Adapted from Orca (MIT, Copyright (c) 2026 Lovecast Inc.)
// src/renderer/src/components/status-bar/provider-extra-usage-section.tsx (barColor) and
// src/shared/usage-percentage-display.ts (clampUsedPercent) @ stablyai/orca 0069492b
// Changes: barColor returns a CSS class for Whiplash's tokens instead of Tailwind classes.

export const USAGE_WARNING_PERCENT = 60
export const USAGE_URGENT_PERCENT = 80

export function clampUsedPercent(usedPercent) {
  if (!Number.isFinite(usedPercent)) {
    return 0
  }
  return Math.max(0, Math.min(100, Math.round(usedPercent)))
}

export function barColor(usedPct) {
  if (usedPct < USAGE_WARNING_PERCENT) {
    return 'usage-calm'
  }
  if (usedPct < USAGE_URGENT_PERCENT) {
    return 'usage-warning'
  }
  return 'usage-urgent'
}
