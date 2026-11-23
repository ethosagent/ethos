// A prompt's size is its fresh input plus both cache buckets — providers that
// cache report `inputTokens` as only the uncached tail.
export function promptTokensOf(e: {
  inputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}): number {
  return e.inputTokens + (e.cacheReadTokens ?? 0) + (e.cacheCreationTokens ?? 0);
}
