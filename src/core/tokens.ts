/**
 * Rough token estimation without a tokenizer dependency. Code tokenises
 * denser than prose; we lean conservative so the context meter errs high.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  const len = text.length
  // Count whitespace-separated chunks and symbol density to pick a divisor.
  let symbols = 0
  for (let i = 0; i < len; i += 7) {
    const c = text.charCodeAt(i)
    if (c < 48 || (c > 57 && c < 65) || (c > 90 && c < 97) || c > 122) symbols++
  }
  const symbolRatio = symbols / Math.max(1, len / 7)
  const divisor = symbolRatio > 0.45 ? 2.8 : symbolRatio > 0.3 ? 3.3 : 4
  return Math.ceil(len / divisor)
}

export function estimateJsonTokens(v: unknown): number {
  try {
    return estimateTokens(JSON.stringify(v))
  } catch {
    return 0
  }
}
