const MENTION = /(?:^|[^\p{L}\p{N}_@./-])@[\p{L}\p{N}_-]+/u

/** Sends a message to the reply target unless it already names someone; the chip stands in for the @name of a `/model` too. */
export function addressTo(text, name) {
  const prose = text.replace(/```[\s\S]*?```|`[^`\n]*`/g, ' ')
  if (!name || text.startsWith('/tempo') || MENTION.test(prose)) {
    return text
  }
  return `@${name} ${text}`
}
