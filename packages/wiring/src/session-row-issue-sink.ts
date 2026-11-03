// Process-wide sink for degraded `sessions.db` rows (plan session-db-repair 6.1).
// `createSessionStore` defaults the store's `onRowIssue` to `reportSessionRowIssue`;
// the host registers the real recorder once (apps/ethos/src/wiring.ts) because
// `getEthosObservability` lives in the app. Pinned by
// `__tests__/session-row-issue.test.ts`.

import type { EthosObservability } from './observability/ethos-observability';

type RowIssue = Parameters<EthosObservability['recordStorageRowIssue']>[0];

/** Cap on the per-process dedup set so a long-lived process cannot grow it without bound. */
const SEEN_CAP = 1000;

let sink: ((issue: RowIssue) => void) | undefined;
const seen = new Set<string>();

/** Register (or clear, with `undefined`) the recorder; resets the per-process dedup. */
export function setSessionRowIssueSink(next: ((issue: RowIssue) => void) | undefined): void {
  sink = next;
  seen.clear();
}

/** Lazy and fail-open: a store read must never fail because the audit sink is down. */
export function reportSessionRowIssue(issue: RowIssue): void {
  if (!sink) return;
  const key = `${issue.table}:${issue.id}:${issue.column}`;
  if (seen.has(key) || seen.size >= SEEN_CAP) return;
  seen.add(key);
  try {
    sink(issue);
  } catch {
    // observability unavailable: the row is still read in degraded form
  }
}
