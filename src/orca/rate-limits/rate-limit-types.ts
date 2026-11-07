// Adapted from Orca (MIT, Copyright (c) 2026 Lovecast Inc.)
// src/shared/rate-limit-types.ts @ stablyai/orca 0069492b
// Changes: only the window shape Whiplash shows.

export type RateLimitWindow = {
  /** Percentage of the window consumed (0–100). */
  usedPercent: number
  /** Window duration in minutes: 300 (5h) or 10080 (7d). */
  windowMinutes: number
  /** Unix ms timestamp when the window resets, if known. */
  resetsAt: number | null
  /** Human-readable reset description, e.g. "2:30 PM" or "Thu". */
  resetDescription: string | null
}
