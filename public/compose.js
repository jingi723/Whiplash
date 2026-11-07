const MENTION = /(?:^|[^\p{L}\p{N}_@./-])@[\p{L}\p{N}_-]+/u

/** Sends a message to the reply target unless it already names someone or is a command. */
export function addressTo(text, name) {
  const prose = text.replace(/```[\s\S]*?```|`[^`\n]*`/g, ' ')
  if (!name || text.startsWith('/') || MENTION.test(prose)) {
    return text
  }
  return `@${name} ${text}`
}
