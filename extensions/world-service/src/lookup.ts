// Paged lookups. `GraphQuery` has a `limit` but no offset or cursor, so "the
// next page" is the same query re-run with a bigger limit. A write or a read
// that decides something from a lookup must not decide from a truncated page:
// it either sees what it needs or the caller refuses.
//
// Pinned by lookup-paging.test.ts.

/** The first page; doubled on each re-query. */
export const LOOKUP_START = 200;
/** The most rows one decision may read: LOOKUP_START doubled four times. */
export const LOOKUP_CEILING = 3200;

export interface PagedLookup<T> {
  result: T;
  /**
   * True when the decision can be made from `result`: the provider did not
   * truncate it, or `satisfied` accepted it. False when the ceiling was reached
   * with the candidate set still cut short.
   */
  complete: boolean;
}

/**
 * Runs `run(limit)` with a growing limit until its result is not truncated,
 * `satisfied` accepts the (still truncated) result, or `ceiling` is reached.
 */
export async function pagedLookup<T extends { truncated: boolean }>(
  run: (limit: number) => Promise<T>,
  opts: { start?: number; ceiling?: number; satisfied?: (r: T) => boolean } = {},
): Promise<PagedLookup<T>> {
  const ceiling = opts.ceiling ?? LOOKUP_CEILING;
  let limit = Math.min(opts.start ?? LOOKUP_START, ceiling);
  for (;;) {
    const result = await run(limit);
    if (!result.truncated || opts.satisfied?.(result)) return { result, complete: true };
    if (limit >= ceiling) return { result, complete: false };
    limit = Math.min(limit * 2, ceiling);
  }
}

/** The stable refusal text for a lookup that could not be completed. */
export const lookupIncomplete = (what: string): string =>
  `lookup_incomplete: could not see every ${what}; nothing was written`;
