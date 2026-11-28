import type { GraphEdge, GraphNode, WorldMountedBy, WorldSchemaParsed } from './types';

// Pure helpers behind the World page. Nothing here touches the DOM, so the
// graph rules are pinned without a canvas (components/world/__tests__/world-logic.test.ts).

/** A world over this many entities opens on search, not on everything (plan 7.3). */
export const LARGE_WORLD_ENTITIES = 500;

export type WorldView =
  | 'graph'
  | 'tree'
  | 'entity'
  | 'changes'
  | 'conflicts'
  | 'schema'
  | 'settings';

export function opensOnSearch(entityCount: number): boolean {
  return entityCount > LARGE_WORLD_ENTITIES;
}

/** The hierarchy edge types that make a world read as a tree. */
const TREE_EDGE_TYPES = ['part_of', 'member_of'] as const;

/** Tree is picked automatically when the schema declares `part_of` or `member_of`. */
export function chooseDefaultView(schema: WorldSchemaParsed | null): 'tree' | 'graph' {
  if (!schema) return 'graph';
  return TREE_EDGE_TYPES.some((t) => t in schema.edges) ? 'tree' : 'graph';
}

const DAY_MS = 86_400_000;

function day(iso: string): string {
  return iso.slice(0, 10);
}

export interface VisibleEdge {
  edge: GraphEdge;
  /** Closed on or before the slider date: drawn dashed, only when shown. */
  ended: boolean;
}

/**
 * Edges as seen at `asOf` (ISO date; null = now). A link not yet opened at
 * `asOf` is dropped. A link closed before `asOf` is dropped unless
 * `showEnded`, in which case it is kept and flagged for a dashed line.
 */
export function visibleEdges(
  edges: readonly GraphEdge[],
  asOf: string | null,
  showEnded: boolean,
  today: string = day(new Date().toISOString()),
): VisibleEdge[] {
  const at = asOf ? day(asOf) : today;
  const out: VisibleEdge[] = [];
  for (const edge of edges) {
    if (edge.validFrom !== null && day(edge.validFrom) > at) continue;
    const ended = edge.validTo !== null && day(edge.validTo) <= at;
    if (ended && !showEnded) continue;
    out.push({ edge, ended });
  }
  return out;
}

/** Slider range: earliest dated edge start to `today`; null when no edge is dated. */
export function dateBounds(
  edges: readonly GraphEdge[],
  today: string = day(new Date().toISOString()),
): { min: string; max: string } | null {
  let min: string | null = null;
  for (const e of edges) {
    if (e.validFrom === null) continue;
    const d = day(e.validFrom);
    if (min === null || d < min) min = d;
  }
  return min === null || min >= today ? null : { min, max: today };
}

export function dayOffsetToDate(min: string, offset: number): string {
  return new Date(Date.parse(`${min}T00:00:00Z`) + offset * DAY_MS).toISOString().slice(0, 10);
}

export function dateToDayOffset(min: string, date: string): number {
  return Math.round(
    (Date.parse(`${day(date)}T00:00:00Z`) - Date.parse(`${min}T00:00:00Z`)) / DAY_MS,
  );
}

/** DESIGN.md tokens only; new per-type tokens are a proposal for the maintainer. */
export const TYPE_COLOR_TOKENS = ['--info', '--success', '--warning', '--text-secondary'] as const;

/** Stable colour token per entity type: index in the sorted type list, wrapping. */
export function typeColorToken(type: string, allTypes: readonly string[]): string {
  const sorted = [...new Set(allTypes)].sort();
  const i = Math.max(0, sorted.indexOf(type));
  return TYPE_COLOR_TOKENS[i % TYPE_COLOR_TOKENS.length] ?? '--info';
}

export interface CytoElements {
  nodes: { data: { id: string; label: string; type: string; token: string; isNew: boolean } }[];
  edges: {
    data: { id: string; source: string; target: string; label: string };
    classes: string;
  }[];
}

/**
 * Cytoscape elements from a graph slice. An edge whose endpoint is not in the
 * slice (truncated or type-filtered) is dropped so Cytoscape never sees a
 * dangling reference. `hiddenTypes` filters node types.
 */
export function buildElements(
  nodes: readonly GraphNode[],
  edges: readonly VisibleEdge[],
  hiddenTypes: ReadonlySet<string> = new Set(),
): CytoElements {
  const allTypes = nodes.map((n) => n.type);
  const kept = nodes.filter((n) => !hiddenTypes.has(n.type));
  const ids = new Set(kept.map((n) => n.id));
  return {
    nodes: kept.map((n) => ({
      data: {
        id: n.id,
        label: n.name,
        type: n.type,
        token: typeColorToken(n.type, allTypes),
        isNew: n.isNew,
      },
    })),
    edges: edges
      .filter(({ edge }) => ids.has(edge.from) && ids.has(edge.to))
      .map(({ edge, ended }) => ({
        data: { id: edge.id, source: edge.from, target: edge.to, label: edge.type },
        classes: ended ? 'ended' : '',
      })),
  };
}

/** Substring search over entity names for the large-world entry screen (fed from `worlds.tree`). */
export function searchNodes<T extends { name: string }>(
  nodes: readonly T[],
  query: string,
  limit = 20,
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return nodes.filter((n) => n.name.toLowerCase().includes(q)).slice(0, limit);
}

/** A mount whose effective mode differs from its requested mode is inert in part. */
export function isInertMount(m: WorldMountedBy): boolean {
  return m.effective !== m.mode || m.note !== undefined;
}
