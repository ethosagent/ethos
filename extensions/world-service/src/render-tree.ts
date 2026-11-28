// The org-chart text of a world: company -> teams -> people, from `part_of` and `member_of`
// edges. ONE renderer for `ethos world show --tree` and the TUI `/world <slug>` panel, so the two
// never drift (pinned by apps/ethos/src/commands/__tests__/world-cli.test.ts 'show --tree prints
// the org chart' and apps/tui/src/__tests__/world-tree.test.ts 'panel renders renderTree
// output'). Pure and deterministic: no clock, no locale (names compare by code point), the same
// bundle always yields the same text (render-tree.test.ts 'renderTree is deterministic').
//
// A child is an entity with a live `part_of` or `member_of` edge to its parent. A root is an entity
// with no parent that has at least one child. Everything else (skills, services, an unattached
// person) is listed once under "Not in the tree", by type, so nothing in the world is hidden.

import type { Edge, Entity, GraphBundle } from '@ethosagent/types';

/** The edge types that make a parent -> child link; `from` is the child, `to` the parent. */
const HIERARCHY = new Set(['part_of', 'member_of']);

export interface RenderTreeOptions {
  /** Show only the subtree of this entity (matched by id, else by name ignoring case). */
  entity?: string;
  /** Lines before the output is cut with a "... N more" line. Default 500. */
  maxLines?: number;
}

const DEFAULT_MAX_LINES = 500;

const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const byNameThenId = (a: Entity, b: Entity): number =>
  byCodePoint(a.name, b.name) || byCodePoint(a.id, b.id);

/** Whether `entity` names nothing in `bundle`; the caller turns this into WORLD_NOT_FOUND. */
export function findTreeEntity(bundle: GraphBundle, entity: string): Entity | undefined {
  const live = bundle.entities.filter((e) => e.retiredAt === null && e.mergedInto === null);
  return (
    live.find((e) => e.id === entity) ??
    live.find((e) => e.name.toLowerCase() === entity.toLowerCase())
  );
}

function label(e: Entity, edge?: Edge): string {
  const role = edge && typeof edge.attrs.role === 'string' ? ` - ${edge.attrs.role}` : '';
  return `${e.name} (${e.type})${role}`;
}

/**
 * `bundle` is the slice to draw (`sliceBundle` for an as-of date); edges closed or retired in it
 * are ignored. Returns the text without a trailing newline; an empty world reads "(empty)".
 */
export function renderTree(bundle: GraphBundle, opts: RenderTreeOptions = {}): string {
  const entities = bundle.entities.filter((e) => e.retiredAt === null && e.mergedInto === null);
  if (entities.length === 0) return '(empty)';
  const byId = new Map(entities.map((e) => [e.id, e]));

  const children = new Map<string, Array<{ child: Entity; edge: Edge }>>();
  const hasParent = new Set<string>();
  for (const edge of bundle.edges) {
    if (edge.retiredAt !== null || edge.validTo !== null || !HIERARCHY.has(edge.type)) continue;
    const child = byId.get(edge.fromId);
    if (!child || !byId.has(edge.toId)) continue;
    hasParent.add(child.id);
    const list = children.get(edge.toId) ?? [];
    list.push({ child, edge });
    children.set(edge.toId, list);
  }
  for (const list of children.values()) list.sort((a, b) => byNameThenId(a.child, b.child));

  const lines: string[] = [];
  const seen = new Set<string>();
  const walk = (
    e: Entity,
    edge: Edge | undefined,
    prefix: string,
    last: boolean,
    root: boolean,
  ) => {
    seen.add(e.id);
    if (root) lines.push(label(e, edge));
    else lines.push(`${prefix}${last ? '`- ' : '|- '}${label(e, edge)}`);
    const kids = (children.get(e.id) ?? []).filter((k) => !seen.has(k.child.id));
    const next = root ? '' : `${prefix}${last ? '   ' : '|  '}`;
    kids.forEach((k, i) => {
      if (!seen.has(k.child.id)) walk(k.child, k.edge, next, i === kids.length - 1, false);
    });
  };

  if (opts.entity !== undefined) {
    const start = findTreeEntity(bundle, opts.entity);
    if (!start) return `(no entity ${opts.entity})`;
    walk(start, undefined, '', true, true);
  } else {
    const roots = entities
      .filter((e) => !hasParent.has(e.id) && (children.get(e.id)?.length ?? 0) > 0)
      .sort(byNameThenId);
    for (const r of roots) walk(r, undefined, '', true, true);
    // A cycle has no parentless member; draw each unseen member of one so it is not hidden.
    for (const e of entities.sort(byNameThenId)) {
      if (!seen.has(e.id) && hasParent.has(e.id) && (children.get(e.id)?.length ?? 0) > 0) {
        walk(e, undefined, '', true, true);
      }
    }
    const rest = entities.filter((e) => !seen.has(e.id));
    if (rest.length > 0) {
      const byType = new Map<string, string[]>();
      for (const e of rest) byType.set(e.type, [...(byType.get(e.type) ?? []), e.name]);
      if (lines.length > 0) lines.push('');
      lines.push('Not in the tree:');
      for (const type of [...byType.keys()].sort(byCodePoint)) {
        lines.push(`  ${type}: ${(byType.get(type) ?? []).sort(byCodePoint).join(', ')}`);
      }
    }
  }

  const max = opts.maxLines ?? DEFAULT_MAX_LINES;
  if (lines.length <= max) return lines.join('\n');
  return [...lines.slice(0, max), `... ${lines.length - max} more lines`].join('\n');
}
