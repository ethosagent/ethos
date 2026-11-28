import type Database from '@ethosagent/sqlite';

// Graph walks as recursive CTEs (plan world-model Task 1.4). Both walks take
// the edge time-slice already rendered by the store (`sliceSql` over the
// `edges` columns, `sliceParams` its bound values), so a closed or retired
// edge is never walked (hops.test.ts 'closed edges are not walked as of a
// later date').

export interface Walk {
  /** Reached entity ids with their shortest depth, nearest first. */
  nodes: Array<{ id: string; depth: number }>;
  /** Rowids of the edges the walk crossed. */
  edgeRowids: number[];
}

/**
 * Entities within `depth` hops of `centre`, crossing live edges in both
 * directions.
 *
 * Cycles end because the CTE is a `UNION` (set semantics) over
 * (node, depth, edge) rows and `depth` is capped, so A→B→A adds each pair once
 * and stops at the cap; a node reached twice keeps its minimum depth. A
 * per-path visited string would also end cycles but multiplies rows by the
 * number of paths, which blows up on hub nodes; this form is bounded by
 * edges × depth. Pinned by hops.test.ts 'cycle reports_to A→B→A ends'.
 */
export function walkNeighbours(
  db: Database.Database,
  world: string,
  centre: string,
  depth: number,
  sliceSql: string,
  sliceParams: string[],
): Walk {
  const rows = db
    .prepare(
      // Two recursive arms (out, in) instead of one `from_id = node OR to_id = node`
      // join: the OR defeats idx_edges_from / idx_edges_to and scans the table.
      // CROSS JOIN keeps `walk` as the outer loop and INDEXED BY pins the index:
      // left to itself the planner makes `edges` the outer loop on idx_edges_recorded
      // and rescans the walk per edge (seconds on 20k edges). Pinned by hops.test.ts
      // 'hop query on 5k entities / 20k edges returns in < 50 ms'.
      `WITH RECURSIVE walk(node, depth, via) AS (
         SELECT ?, 0, NULL
         UNION
         SELECT edges.to_id, walk.depth + 1, edges.rowid
         FROM walk CROSS JOIN edges INDEXED BY idx_edges_from ON edges.world = ? AND edges.from_id = walk.node
         WHERE walk.depth < ? AND ${sliceSql}
         UNION
         SELECT edges.from_id, walk.depth + 1, edges.rowid
         FROM walk CROSS JOIN edges INDEXED BY idx_edges_to ON edges.world = ? AND edges.to_id = walk.node
         WHERE walk.depth < ? AND ${sliceSql}
       )
       SELECT node, depth, via FROM walk`,
    )
    .all(centre, world, depth, ...sliceParams, world, depth, ...sliceParams) as Array<{
    node: string;
    depth: number;
    via: number | null;
  }>;
  const best = new Map<string, { depth: number; via: number }>();
  const edgeRowids = new Set<number>();
  for (const r of rows) {
    if (r.via !== null) edgeRowids.add(r.via);
    const cur = best.get(r.node);
    const via = r.via ?? -1;
    if (!cur || r.depth < cur.depth || (r.depth === cur.depth && via < cur.via)) {
      best.set(r.node, { depth: r.depth, via });
    }
  }
  const nodes = [...best.entries()]
    .sort((a, b) => a[1].depth - b[1].depth || a[1].via - b[1].via)
    .map(([id, v]) => ({ id, depth: v.depth }));
  return { nodes, edgeRowids: [...edgeRowids].sort((a, b) => a - b) };
}

/**
 * Id sequences that start at `from`, follow only `via` edge types in their
 * stored direction for 1..maxHops steps and never revisit an entity (a
 * per-path visited string: `maxHops` is capped at 3 and `limit` bounds the
 * output, so path count is not a concern here, unlike in `walkNeighbours`).
 * `toType` keeps only paths whose last entity has that type. Ordered by depth
 * then by the rowids of the edges crossed.
 */
export function walkPaths(
  db: Database.Database,
  world: string,
  from: string,
  via: string[],
  maxHops: number,
  toType: string | undefined,
  knownAt: string,
  sliceSql: string,
  sliceParams: string[],
  limit: number,
): string[][] {
  if (via.length === 0 || maxHops < 1) return [];
  const rows = db
    .prepare(
      `WITH RECURSIVE p(node, depth, path, rids) AS (
         SELECT ?, 0, ',' || ? || ',', ''
         UNION ALL
         SELECT edges.to_id, p.depth + 1, p.path || edges.to_id || ',',
                p.rids || printf('%012d', edges.rowid)
         FROM p JOIN edges ON edges.world = ? AND edges.from_id = p.node
         WHERE p.depth < ? AND edges.type IN (${via.map(() => '?').join(', ')})
           AND instr(p.path, ',' || edges.to_id || ',') = 0 AND ${sliceSql}
       )
       SELECT p.path FROM p JOIN entities en ON en.id = p.node
       WHERE p.depth >= 1 AND en.recorded_at <= ? AND (en.retired_at IS NULL OR en.retired_at > ?)
         ${toType === undefined ? '' : 'AND en.type = ?'}
       ORDER BY p.depth, p.rids LIMIT ?`,
    )
    .all(
      from,
      from,
      world,
      maxHops,
      ...via,
      ...sliceParams,
      knownAt,
      knownAt,
      ...(toType === undefined ? [] : [toType]),
      limit,
    ) as Array<{ path: string }>;
  return rows.map((r) => r.path.split(',').filter((s) => s !== ''));
}
