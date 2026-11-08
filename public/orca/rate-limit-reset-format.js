// Adapted from Orca (MIT, Copyright (c) 2026 Lovecast Inc.)
// src/shared/rate-limit-reset-format.ts @ stablyai/orca 0069492b
// Changes: TypeScript types removed; only the duration formatters.

/** Floor durations to whole units (47m, 3h 54m, 6d 7h); nonpositive values return now for reset-specific copy. */
export function formatResetDuration(ms) {
  if (ms <= 0) {
    return 'now'
  }
  const totalMins = Math.floor(ms / 60_000)
  if (totalMins < 60) {
    return `${totalMins}m`
  }
  const hours = Math.floor(totalMins / 60)
  const mins = totalMins % 60
  if (hours >= 24) {
    const days = Math.floor(hours / 24)
    const remHours = hours % 24
    return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`
  }
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`
}

/** "Resets in 3h 54m" / "Resets now" for a window's time-until-reset (ms). */
export function formatResetCountdown(ms) {
  const duration = formatResetDuration(ms)
  return duration === 'now' ? 'Resets now' : `Resets in ${duration}`
}
