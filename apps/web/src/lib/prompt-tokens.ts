// Fallback chip size: fresh input plus both cache buckets, for providers (Anthropic)
// that report `inputTokens` as only the uncached tail. The ring does not use this.
export function promptTokensOf(e: {
  inputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}): number {
  return e.inputTokens + (e.cacheReadTokens ?? 0) + (e.cacheCreationTokens ?? 0);
}
