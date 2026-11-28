// Schema changes: what they are, how they classify and how they apply to a
// schema value. Pure: no I/O. WorldSchemaService (schema-service.ts) owns
// the rules table that decides WHO may apply which class; this file only
// answers "what does the change do".

import type { AttrSpec, WorldSchema } from '@ethosagent/types';
import { type SchemaDoc, sensitiveKey } from './schema-model';

export type SchemaChange =
  | { op: 'add_entity_type'; type: string; attrs?: Record<string, AttrSpec> }
  | {
      op: 'add_edge_type';
      type: string;
      from: string[];
      to: string[];
      attrs?: Record<string, AttrSpec>;
      unique?: 'from' | 'to';
    }
  | { op: 'add_attribute'; on: { entity: string } | { edge: string }; key: string; spec: AttrSpec }
  | { op: 'add_allowed_pair'; edge: string; from?: string; to?: string }
  | { op: 'rename_type'; kind: 'entity' | 'edge'; from: string; to: string }
  | { op: 'rename_attribute'; on: { entity: string } | { edge: string }; from: string; to: string }
  | { op: 'merge_types'; kind: 'entity'; from: string; into: string }
  | { op: 'remove_type'; kind: 'entity' | 'edge'; type: string };

export type ChangeClass = 'additive' | 'rewrite';

/** add_* → additive; rename, merge and remove → rewrite. */
export function classifySchemaChange(c: SchemaChange): ChangeClass {
  switch (c.op) {
    case 'add_entity_type':
    case 'add_edge_type':
    case 'add_attribute':
    case 'add_allowed_pair':
      return 'additive';
    case 'rename_type':
    case 'rename_attribute':
    case 'merge_types':
    case 'remove_type':
      return 'rewrite';
  }
}

const NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

const onLabel = (on: { entity: string } | { edge: string }): string =>
  'entity' in on ? `entity ${on.entity}` : `edge ${on.edge}`;

/** One line for the changelog and the proposal summary. */
export function describeChange(c: SchemaChange): string {
  switch (c.op) {
    case 'add_entity_type':
      return `add entity ${c.type}`;
    case 'add_edge_type':
      return `add edge ${c.type}`;
    case 'add_attribute':
      return `add attribute ${c.key} on ${onLabel(c.on)}`;
    case 'add_allowed_pair':
      return `allow ${c.edge} ${c.from ? `from ${c.from}` : ''}${c.from && c.to ? ' ' : ''}${c.to ? `to ${c.to}` : ''}`.trim();
    case 'rename_type':
      return `rename ${c.kind} ${c.from} to ${c.to}`;
    case 'rename_attribute':
      return `rename attribute ${c.from} to ${c.to} on ${onLabel(c.on)}`;
    case 'merge_types':
      return `merge entity ${c.from} into ${c.into}`;
    case 'remove_type':
      return `remove ${c.kind} ${c.type}`;
  }
}

export type ApplyResult =
  | ({ ok: true } & Pick<SchemaDoc, 'schema' | 'sensitive'>)
  | {
      ok: false;
      error: string;
    };

const fail = (error: string): ApplyResult => ({ ok: false, error });

function attrsOf(
  schema: WorldSchema,
  on: { entity: string } | { edge: string },
): Record<string, AttrSpec> | null {
  if ('entity' in on) return schema.entities[on.entity]?.attrs ?? null;
  return schema.edges[on.edge]?.attrs ?? null;
}

/**
 * Applies `change` to a copy of `base`. Refuses (with a reason) anything the
 * result would not hold together: a duplicate type, a missing type, an edge
 * left with no endpoint. Does not touch facts: a rewrite's fact migration is
 * WorldSchemaService's job.
 */
export function applyChange(
  base: Pick<SchemaDoc, 'schema' | 'sensitive'>,
  c: SchemaChange,
): ApplyResult {
  const schema = structuredClone(base.schema);
  let sensitive = [...base.sensitive];
  const checkName = (n: string, what: string): string | null =>
    NAME.test(n) ? null : `${what} '${n}' must start with a letter and use letters, digits and _`;

  switch (c.op) {
    case 'add_entity_type': {
      const bad = checkName(c.type, 'entity type');
      if (bad) return fail(bad);
      if (schema.entities[c.type]) return fail(`entity type '${c.type}' already exists`);
      schema.entities[c.type] = { attrs: c.attrs ?? {} };
      break;
    }
    case 'add_edge_type': {
      const bad = checkName(c.type, 'edge type');
      if (bad) return fail(bad);
      if (schema.edges[c.type]) return fail(`edge type '${c.type}' already exists`);
      if (c.from.length === 0 || c.to.length === 0) return fail('an edge needs from and to types');
      for (const end of [...c.from, ...c.to]) {
        if (!schema.entities[end]) return fail(`unknown entity type '${end}'`);
      }
      schema.edges[c.type] = {
        from: [...c.from],
        to: [...c.to],
        attrs: c.attrs ?? {},
        ...(c.unique ? { unique: c.unique } : {}),
      };
      break;
    }
    case 'add_attribute': {
      const bad = checkName(c.key, 'attribute');
      if (bad) return fail(bad);
      const attrs = attrsOf(schema, c.on);
      if (!attrs) return fail(`${onLabel(c.on)} does not exist`);
      if (attrs[c.key]) return fail(`attribute '${c.key}' already exists on ${onLabel(c.on)}`);
      attrs[c.key] = c.spec;
      break;
    }
    case 'add_allowed_pair': {
      const edge = schema.edges[c.edge];
      if (!edge) return fail(`edge type '${c.edge}' does not exist`);
      if (c.from === undefined && c.to === undefined) return fail('give a from or a to type');
      for (const [side, t] of [
        ['from', c.from],
        ['to', c.to],
      ] as const) {
        if (t === undefined) continue;
        if (!schema.entities[t]) return fail(`unknown entity type '${t}'`);
        if (edge[side].includes(t)) return fail(`'${t}' is already allowed on ${c.edge}.${side}`);
        edge[side].push(t);
      }
      break;
    }
    case 'rename_type': {
      const bad = checkName(c.to, `${c.kind} type`);
      if (bad) return fail(bad);
      const table = c.kind === 'entity' ? schema.entities : schema.edges;
      const old = table[c.from];
      if (!old) return fail(`${c.kind} type '${c.from}' does not exist`);
      if (table[c.to]) return fail(`${c.kind} type '${c.to}' already exists`);
      delete table[c.from];
      (table as Record<string, unknown>)[c.to] = old;
      if (c.kind === 'entity') {
        for (const e of Object.values(schema.edges)) {
          e.from = e.from.map((t) => (t === c.from ? c.to : t));
          e.to = e.to.map((t) => (t === c.from ? c.to : t));
        }
      }
      sensitive = sensitive.map((k) => retype(k, c.kind, c.from, c.to));
      break;
    }
    case 'rename_attribute': {
      const bad = checkName(c.to, 'attribute');
      if (bad) return fail(bad);
      const attrs = attrsOf(schema, c.on);
      if (!attrs) return fail(`${onLabel(c.on)} does not exist`);
      const spec = attrs[c.from];
      if (!spec) return fail(`attribute '${c.from}' does not exist on ${onLabel(c.on)}`);
      if (attrs[c.to]) return fail(`attribute '${c.to}' already exists on ${onLabel(c.on)}`);
      delete attrs[c.from];
      attrs[c.to] = spec;
      const [kind, type] =
        'entity' in c.on ? (['entity', c.on.entity] as const) : (['edge', c.on.edge] as const);
      sensitive = sensitive.map((k) =>
        k === sensitiveKey(kind, type, c.from) ? sensitiveKey(kind, type, c.to) : k,
      );
      break;
    }
    case 'merge_types': {
      if (c.from === c.into) return fail('cannot merge a type into itself');
      const from = schema.entities[c.from];
      const into = schema.entities[c.into];
      if (!from) return fail(`entity type '${c.from}' does not exist`);
      if (!into) return fail(`entity type '${c.into}' does not exist`);
      for (const [k, spec] of Object.entries(from.attrs)) into.attrs[k] ??= spec;
      delete schema.entities[c.from];
      for (const e of Object.values(schema.edges)) {
        e.from = [...new Set(e.from.map((t) => (t === c.from ? c.into : t)))];
        e.to = [...new Set(e.to.map((t) => (t === c.from ? c.into : t)))];
      }
      sensitive = [...new Set(sensitive.map((k) => retype(k, 'entity', c.from, c.into)))];
      break;
    }
    case 'remove_type': {
      if (c.kind === 'entity') {
        if (!schema.entities[c.type]) return fail(`entity type '${c.type}' does not exist`);
        for (const [name, e] of Object.entries(schema.edges)) {
          const from = e.from.filter((t) => t !== c.type);
          const to = e.to.filter((t) => t !== c.type);
          if (from.length === 0 || to.length === 0) {
            return fail(
              `edge '${name}' would be left with no ${from.length === 0 ? 'from' : 'to'} type; remove it first`,
            );
          }
          e.from = from;
          e.to = to;
        }
        delete schema.entities[c.type];
      } else {
        if (!schema.edges[c.type]) return fail(`edge type '${c.type}' does not exist`);
        delete schema.edges[c.type];
      }
      sensitive = sensitive.filter((k) => !k.startsWith(`${c.kind}:${c.type}.`));
      break;
    }
  }
  return { ok: true, schema, sensitive };
}

/** Rewrites the type part of a `entity:T.a` / `edge:t.a` sensitive key. */
function retype(key: string, kind: 'entity' | 'edge', from: string, to: string): string {
  const prefix = `${kind}:${from}.`;
  return key.startsWith(prefix) ? `${kind}:${to}.${key.slice(prefix.length)}` : key;
}

/**
 * A schema that accepts both `a` and `b`: what the provider holds WHILE a
 * rename or merge re-asserts facts, so the new names are assertable before the
 * old ones are dropped. The final `applySchema` then installs `b` alone.
 */
export function unionSchema(a: WorldSchema, b: WorldSchema): WorldSchema {
  const entities: WorldSchema['entities'] = {};
  for (const src of [a, b]) {
    for (const [t, e] of Object.entries(src.entities)) {
      entities[t] = { attrs: { ...(entities[t]?.attrs ?? {}), ...e.attrs } };
    }
  }
  const edges: WorldSchema['edges'] = {};
  for (const src of [a, b]) {
    for (const [t, e] of Object.entries(src.edges)) {
      const prev = edges[t];
      edges[t] = {
        from: [...new Set([...(prev?.from ?? []), ...e.from])],
        to: [...new Set([...(prev?.to ?? []), ...e.to])],
        attrs: { ...(prev?.attrs ?? {}), ...e.attrs },
        ...(e.unique ? { unique: e.unique } : {}),
      };
    }
  }
  return { version: b.version, entities, edges };
}
