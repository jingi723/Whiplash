// Adapted from Orca (MIT, Copyright (c) 2026 Lovecast Inc.)
// src/shared/own-retained-string.ts @ stablyai/orca 0069492b
// Changes: Node-only, so the Buffer copier is used directly and the renderer fallback is dropped.

// V8 SlicedString::kMinLength. Shorter slices are already flat, so copying them is pure waste.
const MIN_SLICED_STRING_LENGTH = 13

/** Copy retained tails: V8 SlicedStrings can pin megabytes of already-consumed parent chunks. */
export function ownRetainedString(value: string): string {
  if (value.length < MIN_SLICED_STRING_LENGTH) {
    return value
  }
  return Buffer.from(value, 'utf16le').toString('utf16le')
}
