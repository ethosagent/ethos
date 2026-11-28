// One time slice of a GraphBundle, for exports. Same predicate as the
// store's read path (plan Task 1.3), pinned here by
// __tests__/exports.test.ts 'as-of slice excludes closed edges':
//   world clock: (validFrom null or <= asOf) and (validTo null or > asOf)
//   Ethos clock: recordedAt <= knownAt and (retiredAt null or > knownAt)
// Timestamps are ISO-8601 UTC strings, so string comparison is time order.

import type { AttributeFact, Edge, Entity, GraphBundle, TimeSlice } from '@ethosagent/types';

function knownAtClock(f: { recordedAt: string; retiredAt: string | null }, knownAt: string) {
  return f.recordedAt <= knownAt && (f.retiredAt === null || f.retiredAt > knownAt);
}

function worldClock(f: { validFrom: string | null; validTo: string | null }, asOf: string) {
  return (f.validFrom === null || f.validFrom <= asOf) && (f.validTo === null || f.validTo > asOf);
}

/** Facts true at `asOf` as Ethos knew them at `knownAt` (both default to now). Edges whose endpoint is not in the slice are dropped. */
export function sliceBundle(bundle: GraphBundle, slice: TimeSlice = {}): GraphBundle {
  const now = new Date().toISOString();
  const asOf = slice.asOf ?? now;
  const knownAt = slice.knownAt ?? now;
  const entities: Entity[] = bundle.entities.filter((e) => knownAtClock(e, knownAt));
  const ids = new Set(entities.map((e) => e.id));
  const attributes: AttributeFact[] = bundle.attributes.filter(
    (a) => ids.has(a.entityId) && worldClock(a, asOf) && knownAtClock(a, knownAt),
  );
  const edges: Edge[] = bundle.edges.filter(
    (e) => ids.has(e.fromId) && ids.has(e.toId) && worldClock(e, asOf) && knownAtClock(e, knownAt),
  );
  return { schema: bundle.schema, entities, attributes, edges };
}
