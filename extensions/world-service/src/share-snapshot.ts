// Frozen, redacted, read-only copy of one world view for a share link (plan world-model 7.6).
//
// Guarantees, each pinned by __tests__/world-snapshot.test.ts:
// - attributes the schema marks `sensitive` (`entity:Type.attr`, `edge:type.attr`, see
//   `sensitiveKey`) never appear, nor do keys containing `email` or `location` unless the
//   owner unticks them ('snapshot strips sensitive and email fields');
// - the view is the world as of `asOf` and as Ethos knew it at `createdAt`, so a fact recorded
//   later is absent ('snapshot is frozen: a later fact does not appear'); the function is pure;
// - every string (title, names, aliases, keys, values) passes `redactString`, then `redactPii`;
// - output above `maxBytes` is a `too_large` refusal, not a truncation ('refuses above the byte cap').

import { redactPii, redactString } from '@ethosagent/safety-redact';
import type { GraphBundle } from '@ethosagent/types';
import { sliceBundle } from './codecs/slice';
import { sensitiveKey } from './schema-model';

export interface WorldSnapshotAttr {
  key: string;
  value: string;
}

export interface WorldSnapshotLink {
  type: string;
  direction: 'out' | 'in';
  otherId: string;
  otherName: string;
}

export interface WorldSnapshotEntity {
  /** In-page anchor target. */
  id: string;
  name: string;
  aliases: string[];
  attrs: WorldSnapshotAttr[];
  links: WorldSnapshotLink[];
}

export interface WorldSnapshotEdge {
  type: string;
  fromId: string;
  fromName: string;
  toId: string;
  toName: string;
  attrs: WorldSnapshotAttr[];
}

export interface WorldSnapshot {
  v: 1;
  kind: 'world';
  world: string;
  title: string;
  view: 'tree' | 'graph';
  asOf: string;
  createdAt: string;
  groups: Array<{ type: string; entities: WorldSnapshotEntity[] }>;
  /** Graph view only: every relationship once. */
  edges?: WorldSnapshotEdge[];
  /** Human labels of what was stripped, shown to the owner and on the page. */
  redacted: string[];
}

export interface WorldSnapshotOptions {
  world: string;
  title: string;
  view: 'tree' | 'graph';
  asOf: string;
  /** Stamped on the snapshot and used as the Ethos clock; supplied by the caller. */
  createdAt: string;
  /** `LoadedSchema.sensitive`. */
  sensitive: readonly string[];
  /** Owner unticked "strip email". Default false (stripped). */
  keepEmail?: boolean;
  /** Owner unticked "strip location". Default false (stripped). */
  keepLocation?: boolean;
  maxBytes: number;
}

export type WorldSnapshotResult =
  | { ok: true; snapshot: WorldSnapshot; bytes: number }
  | { ok: false; reason: 'too_large'; limitBytes: number };

export function buildWorldSnapshot(
  bundle: GraphBundle,
  options: WorldSnapshotOptions,
): WorldSnapshotResult {
  const scrub = (value: string): string => redactPii(redactString(value));
  const sens = new Set(options.sensitive);
  const stripped = (key: string, sensitiveOn: string): boolean => {
    if (sens.has(sensitiveOn)) return true;
    const k = key.toLowerCase();
    if (!options.keepEmail && k.includes('email')) return true;
    if (!options.keepLocation && k.includes('location')) return true;
    return false;
  };
  const show = (v: unknown): string => scrub(typeof v === 'string' ? v : JSON.stringify(v));

  const slice = sliceBundle(bundle, { asOf: options.asOf, knownAt: options.createdAt });
  // A merged-away entity is represented by the one it merged into.
  const live = { ...slice, entities: slice.entities.filter((e) => e.mergedInto === null) };
  const byId = new Map(live.entities.map((e) => [e.id, e]));
  const nameOf = (id: string): string => scrub(byId.get(id)?.name ?? id);

  const entities = new Map<string, WorldSnapshotEntity>();
  const types = new Map<string, WorldSnapshotEntity[]>();
  for (const e of live.entities) {
    const out: WorldSnapshotEntity = {
      id: e.id,
      name: scrub(e.name),
      aliases: e.aliases.map(scrub),
      attrs: [],
      links: [],
    };
    entities.set(e.id, out);
    const list = types.get(e.type) ?? [];
    list.push(out);
    types.set(e.type, list);
  }
  for (const a of live.attributes) {
    const owner = byId.get(a.entityId);
    const target = entities.get(a.entityId);
    if (!owner || !target || stripped(a.key, sensitiveKey('entity', owner.type, a.key))) continue;
    target.attrs.push({ key: scrub(a.key), value: show(a.value) });
  }
  const graphEdges: WorldSnapshotEdge[] = [];
  for (const ed of live.edges) {
    const attrs = Object.entries(ed.attrs)
      .filter(([k]) => !stripped(k, sensitiveKey('edge', ed.type, k)))
      .map(([k, v]) => ({ key: scrub(k), value: show(v) }));
    const type = scrub(ed.type);
    entities
      .get(ed.fromId)
      ?.links.push({ type, direction: 'out', otherId: ed.toId, otherName: nameOf(ed.toId) });
    entities
      .get(ed.toId)
      ?.links.push({ type, direction: 'in', otherId: ed.fromId, otherName: nameOf(ed.fromId) });
    graphEdges.push({
      type,
      fromId: ed.fromId,
      fromName: nameOf(ed.fromId),
      toId: ed.toId,
      toName: nameOf(ed.toId),
      attrs,
    });
  }

  const redacted = ['sensitive attributes'];
  if (!options.keepEmail) redacted.push('email');
  if (!options.keepLocation) redacted.push('location');

  const snapshot: WorldSnapshot = {
    v: 1,
    kind: 'world',
    world: options.world,
    title: scrub(options.title),
    view: options.view,
    asOf: options.asOf,
    createdAt: options.createdAt,
    groups: [...types]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([type, list]) => ({
        type: scrub(type),
        entities: list.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
      })),
    ...(options.view === 'graph' ? { edges: graphEdges } : {}),
    redacted,
  };
  const bytes = Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
  if (bytes > options.maxBytes)
    return { ok: false, reason: 'too_large', limitBytes: options.maxBytes };
  return { ok: true, snapshot, bytes };
}
