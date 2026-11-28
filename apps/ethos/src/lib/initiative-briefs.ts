/** The highest-version brief of one exploration, or undefined when it has none. */
export function latestBrief<B extends { explorationId: string; version: number }>(
  briefs: readonly B[],
  explorationId: string,
): B | undefined {
  let best: B | undefined;
  for (const b of briefs) {
    if (b.explorationId === explorationId && (!best || b.version > best.version)) best = b;
  }
  return best;
}
