// Ripple walk: from the stocks an event touched, follow supply edges to the
// stocks on a watchlist. Read-only research. A graph path is a reason to look,
// not advice and not causation; every rendering carries RIPPLE_DISCLAIMER
// (pinned by ripple.test.ts 'every result line carries its sources').
//
// Uses 'edges' and 'entities' queries through WorldService.query rather than
// the provider 'paths' query: the walk needs each edge's `share` and
// sourceRef, which 'paths' (bare id chains) does not return. Closed edges are
// not walked: GraphQuery 'edges' without includeClosed returns live edges only
// (pinned by ripple.test.ts 'closed supplies edges are not walked').

import type { Edge, GraphQuery } from '@ethosagent/types';
import { pagedLookup } from './lookup';
import type { Caller, WorldService } from './service';

export const RIPPLE_DISCLAIMER = 'A graph path is a reason to look, not advice.';

export interface RippleInput {
  world: string;
  eventId: string;
  /** Edge types to walk. Default ['supplies']. */
  via?: string[];
  /** Max walked edges. Default 3. */
  maxHops?: number;
  /** Name of the List entity; default any `watched_in` target. */
  listName?: string;
  /**
   * 'customers' (default): follow edges from the affected stock to its
   * customers (A supplies B: A -> B). 'suppliers' walks them backwards,
   * 'both' either way.
   */
  direction?: 'customers' | 'suppliers' | 'both';
}

export interface RippleResult {
  stock: string;
  /** Stock names from the affected stock to `stock`. */
  path: string[];
  sources: string[];
}

const START = 500;
const CEILING = 8000;

export async function rippleWalk(
  service: Pick<WorldService, 'query'>,
  c: Caller,
  input: RippleInput,
): Promise<RippleResult[]> {
  const via = input.via ?? ['supplies'];
  const maxHops = input.maxHops ?? 3;
  const direction = input.direction ?? 'customers';
  // A truncated page would silently drop edges from the walk: page to completeness, else throw.
  const q = async (query: (limit: number) => GraphQuery) => {
    const page = await pagedLookup((limit) => service.query(c, input.world, query(limit)), {
      start: START,
      ceiling: CEILING,
    });
    if (!page.complete) {
      throw new Error(`lookup_incomplete: over ${CEILING} rows match a ripple query; not walked`);
    }
    return page.result;
  };

  const names = new Map<string, string>();
  const lists = new Set<string>();
  const ents = await q((limit) => ({ kind: 'entities', types: ['Stock', 'List'], limit }));
  for (const e of ents.entities) {
    names.set(e.id, e.name);
    if (e.type === 'List' && (input.listName === undefined || e.name === input.listName)) {
      lists.add(e.id);
    }
  }
  const watchedEdges = (await q((limit) => ({ kind: 'edges', types: ['watched_in'], limit })))
    .edges;
  const watched = new Map<string, Edge>();
  for (const e of watchedEdges) if (lists.has(e.toId)) watched.set(e.fromId, e);

  const affected = (
    await q((limit) => ({ kind: 'edges', types: ['affected_by'], toId: input.eventId, limit }))
  ).edges;

  const found = new Map<string, { hops: Edge[]; ids: string[]; affectedBy: Edge }>();
  const rank = (hops: Edge[]) => hops.length;
  for (const start of affected) {
    const stack: Array<{ ids: string[]; hops: Edge[] }> = [{ ids: [start.fromId], hops: [] }];
    while (stack.length > 0) {
      const cur = stack.pop();
      if (!cur) break;
      const at = cur.ids[cur.ids.length - 1] as string;
      if (cur.hops.length > 0 && watched.has(at)) {
        const prev = found.get(at);
        const better =
          !prev ||
          rank(cur.hops) < rank(prev.hops) ||
          (rank(cur.hops) === rank(prev.hops) && shareProduct(cur.hops) > shareProduct(prev.hops));
        if (better) found.set(at, { hops: cur.hops, ids: cur.ids, affectedBy: start });
      }
      if (cur.hops.length >= maxHops) continue;
      const next: Array<{ edge: Edge; to: string }> = [];
      if (direction !== 'suppliers') {
        const r = await q((limit) => ({ kind: 'edges', types: via, fromId: at, limit }));
        next.push(...r.edges.map((edge) => ({ edge, to: edge.toId })));
      }
      if (direction !== 'customers') {
        const r = await q((limit) => ({ kind: 'edges', types: via, toId: at, limit }));
        next.push(...r.edges.map((edge) => ({ edge, to: edge.fromId })));
      }
      for (const n of next) {
        if (cur.ids.includes(n.to)) continue;
        stack.push({ ids: [...cur.ids, n.to], hops: [...cur.hops, n.edge] });
      }
    }
  }

  return [...found.entries()]
    .sort(
      (a, b) =>
        a[1].hops.length - b[1].hops.length ||
        shareProduct(b[1].hops) - shareProduct(a[1].hops) ||
        (names.get(a[0]) ?? '').localeCompare(names.get(b[0]) ?? ''),
    )
    .map(([id, f]) => ({
      stock: names.get(id) ?? id,
      path: f.ids.map((s) => names.get(s) ?? s),
      sources: [
        ...new Set([
          f.affectedBy.sourceRef,
          ...f.hops.map((h) => h.sourceRef),
          (watched.get(id) as Edge).sourceRef,
        ]),
      ],
    }));
}

/** Product of `share` over hops where it is a number; unknown shares count as 1. */
function shareProduct(hops: Edge[]): number {
  let p = 1;
  for (const h of hops) {
    const s = h.attrs.share;
    if (typeof s === 'number') p *= s;
  }
  return p;
}

/** One line per result plus the disclaimer. */
export function formatRipple(results: RippleResult[]): string {
  const lines = results.map((r) => `${r.path.join(' → ')} (sources: ${r.sources.join(', ')})`);
  return [...lines, RIPPLE_DISCLAIMER].join('\n');
}
