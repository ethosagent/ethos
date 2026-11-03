// Words shared by `ethos doctor` and `ethos sessions repair` so the two never
// describe the same failure differently. Pinned by
// apps/ethos/src/commands/__tests__/doctor-status-stores.test.ts.

/** What a damaged `messages_fts` index costs the operator. */
export const FTS_DOWN_CONSEQUENCE =
  'Search is down and new messages cannot be saved or pruned until the index is rebuilt.';
