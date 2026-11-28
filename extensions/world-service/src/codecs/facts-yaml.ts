// Schema + facts YAML codec (`ethos world export <world> --yaml`). Pure: no
// I/O, no clock (import takes `now` for facts that omit `recorded_at`).
//
// Document shape:
//
//   schema:            # the canonical schema.yaml form (serializeSchemaYaml), or null
//     version: 2
//     entities: ...
//   facts:
//     entities:
//       - type: Person
//         name: Ada
//         aliases: [ "A. L." ]            # only when non-empty
//         recorded_at: ...
//         retired_at: ...                 # only when retired
//         merged_into: { type: Person, name: Ada Lovelace }   # only when merged
//         source: chat:1
//         author: user
//         attributes:                     # only when the entity has any
//           - { key: level, value: 4, valid_from: 2026-01-01, ... }
//     edges:
//       - type: member_of
//         from: { type: Person, name: Ada }
//         to: { type: Team, name: Platform }
//         attrs: { role: lead }           # only when non-empty
//         valid_from / valid_to           # each only when non-null; a closed edge has both
//         recorded_at, retired_at?, source, author, confidence
//
// IDS: the file carries NO ids. Entities are referenced by `{ type, name }`
// and attributes hang under their entity, so a diff shows names, not
// opaque keys. Import assigns positional placeholder ids (ent-N, attr-N,
// edge-N in document order); export never reads them, so byte identity does
// not depend on them (test 'export → import → export is byte-identical').
//
// ORDER: entities by type then name; attributes by key, valid_from,
// recorded_at; edges by type, from, to, valid_from, recorded_at. Comparison
// is by UTF-16 code unit, not locale, so the order is the same on every host.
//
// LIMITS, not guarantees: `{ type, name }` must identify one entity; a
// second entity with the same pair is skipped on import (reported with its
// line). `sensitive` flags and the schema changelog are not part of
// `GraphBundle.schema` and are not exported. Value, attribute and schema
// validation beyond the unknown-type checks is the service's job.

import type {
  AttributeFact,
  Edge,
  Entity,
  FactAuthor,
  GraphBundle,
  ImportReport,
  WorldId,
} from '@ethosagent/types';
import { Document, isCollection, isScalar, LineCounter, parseDocument, visit } from 'yaml';
import { z } from 'zod';
import { posOf } from '../config';
import { parseSchemaYaml, type SchemaIssue, serializeSchemaYaml } from '../schema-model';

export interface FactsYamlOptions {
  /** Used as `recordedAt` for facts that omit `recorded_at`. */
  now: string;
}

export type FactsYamlImport =
  | { ok: true; bundle: GraphBundle; report: ImportReport }
  | { ok: false; errors: SchemaIssue[] };

const DEFAULT_SOURCE = 'import:facts-yaml';
const FLOW_KEYS = new Set(['aliases', 'from', 'to', 'merged_into', 'attrs']);

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const cmpNullable = (a: string | null, b: string | null): number => cmp(a ?? '', b ?? '');

// ── export ────────────────────────────────────────────────────────────────

export function exportFactsYaml(bundle: GraphBundle): string {
  const byId = new Map(bundle.entities.map((e) => [e.id, e]));
  const ref = (id: string) => {
    const e = byId.get(id);
    return e ? { type: e.type, name: e.name } : { type: '?', name: id };
  };

  const attrsOf = new Map<string, AttributeFact[]>();
  for (const a of bundle.attributes) {
    const list = attrsOf.get(a.entityId) ?? [];
    list.push(a);
    attrsOf.set(a.entityId, list);
  }

  const entities = [...bundle.entities]
    .sort((a, b) => cmp(a.type, b.type) || cmp(a.name, b.name))
    .map((e) => {
      const merged = e.mergedInto ? byId.get(e.mergedInto) : undefined;
      const attributes = (attrsOf.get(e.id) ?? [])
        .sort(
          (a, b) =>
            cmp(a.key, b.key) ||
            cmpNullable(a.validFrom, b.validFrom) ||
            cmp(a.recordedAt, b.recordedAt),
        )
        .map((a) => ({
          key: a.key,
          value: a.value,
          ...(a.validFrom !== null ? { valid_from: a.validFrom } : {}),
          ...(a.validTo !== null ? { valid_to: a.validTo } : {}),
          recorded_at: a.recordedAt,
          ...(a.retiredAt !== null ? { retired_at: a.retiredAt } : {}),
          source: a.sourceRef,
          author: a.author,
          confidence: a.confidence,
        }));
      return {
        type: e.type,
        name: e.name,
        ...(e.aliases.length > 0 ? { aliases: e.aliases } : {}),
        recorded_at: e.recordedAt,
        ...(e.retiredAt !== null ? { retired_at: e.retiredAt } : {}),
        ...(merged ? { merged_into: { type: merged.type, name: merged.name } } : {}),
        source: e.sourceRef,
        author: e.author,
        ...(attributes.length > 0 ? { attributes } : {}),
      };
    });

  const edges = [...bundle.edges]
    .map((e) => ({ e, from: ref(e.fromId), to: ref(e.toId) }))
    .sort(
      (a, b) =>
        cmp(a.e.type, b.e.type) ||
        cmp(a.from.type, b.from.type) ||
        cmp(a.from.name, b.from.name) ||
        cmp(a.to.type, b.to.type) ||
        cmp(a.to.name, b.to.name) ||
        cmpNullable(a.e.validFrom, b.e.validFrom) ||
        cmp(a.e.recordedAt, b.e.recordedAt),
    )
    .map(({ e, from, to }) => ({
      type: e.type,
      from,
      to,
      ...(Object.keys(e.attrs).length > 0 ? { attrs: e.attrs } : {}),
      ...(e.validFrom !== null ? { valid_from: e.validFrom } : {}),
      ...(e.validTo !== null ? { valid_to: e.validTo } : {}),
      recorded_at: e.recordedAt,
      ...(e.retiredAt !== null ? { retired_at: e.retiredAt } : {}),
      source: e.sourceRef,
      author: e.author,
      confidence: e.confidence,
    }));

  const doc = new Document({ schema: null, facts: { entities, edges } });
  if (bundle.schema) {
    const schemaDoc = parseDocument(
      serializeSchemaYaml({ schema: bundle.schema, sensitive: [], changelog: [] }),
    );
    doc.set('schema', schemaDoc.contents);
  }
  visit(doc, {
    Pair(_, pair) {
      const k = isScalar(pair.key) ? pair.key.value : undefined;
      if (typeof k === 'string' && FLOW_KEYS.has(k) && isCollection(pair.value)) {
        pair.value.flow = true;
      }
    },
  });
  return doc.toString({ lineWidth: 0, flowCollectionPadding: true });
}

// ── import ────────────────────────────────────────────────────────────────

const refZ = z.object({ type: z.string().min(1), name: z.string().min(1) }).strict();
const authorZ = z.enum(['user', 'import', 'connector', 'agent']);
const isoZ = z.string().min(1);

const attributeZ = z
  .object({
    key: z.string().min(1),
    value: z.unknown(),
    valid_from: isoZ.optional(),
    valid_to: isoZ.optional(),
    recorded_at: isoZ.optional(),
    retired_at: isoZ.optional(),
    source: z.string().min(1).optional(),
    author: authorZ.optional(),
    confidence: z.number().min(0).max(1).optional(),
  })
  .strict();

const entityZ = z
  .object({
    type: z.string().min(1),
    name: z.string().min(1),
    aliases: z.array(z.string()).optional(),
    recorded_at: isoZ.optional(),
    retired_at: isoZ.optional(),
    merged_into: refZ.optional(),
    source: z.string().min(1).optional(),
    author: authorZ.optional(),
    attributes: z.array(attributeZ).optional(),
  })
  .strict();

const edgeZ = z
  .object({
    type: z.string().min(1),
    from: refZ,
    to: refZ,
    attrs: z.record(z.string(), z.unknown()).optional(),
    valid_from: isoZ.optional(),
    valid_to: isoZ.optional(),
    recorded_at: isoZ.optional(),
    retired_at: isoZ.optional(),
    source: z.string().min(1).optional(),
    author: authorZ.optional(),
    confidence: z.number().min(0).max(1).optional(),
  })
  .strict();

const fileZ = z
  .object({
    schema: z.unknown(),
    facts: z
      .object({
        entities: z.array(entityZ).default([]),
        edges: z.array(edgeZ).default([]),
      })
      .strict()
      .default({ entities: [], edges: [] }),
  })
  .strict();

const key = (t: string, n: string) => `${t}/${n}`;

export function importFactsYaml(
  text: string,
  world: WorldId,
  opts: FactsYamlOptions,
): FactsYamlImport {
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc, uniqueKeys: true });
  if (doc.errors.length > 0) {
    return {
      ok: false,
      errors: doc.errors.map((e) => ({
        line: e.linePos?.[0].line ?? 1,
        column: e.linePos?.[0].col,
        message: (e.message.split('\n')[0] ?? e.code).replace(/ at line \d+, column \d+:?$/, ''),
      })),
    };
  }
  const at = (path: ReadonlyArray<PropertyKey>) => posOf(doc, lc, path).line;

  const parsed = fileZ.safeParse(doc.toJS());
  if (!parsed.success) {
    const errors: SchemaIssue[] = [];
    for (const i of parsed.error.issues) {
      if (i.code === 'unrecognized_keys') {
        for (const k of i.keys)
          errors.push({ line: at([...i.path, k]), message: `unknown key "${k}"` });
      } else {
        const where = i.path.length > 0 ? `${i.path.join('.')}: ` : '';
        errors.push({ line: at(i.path), message: `${where}${i.message}` });
      }
    }
    return { ok: false, errors };
  }

  let schema: GraphBundle['schema'] = null;
  const schemaNode = doc.get('schema', true);
  if (parsed.data.schema !== null && parsed.data.schema !== undefined) {
    const schemaDoc = new Document(schemaNode);
    const schemaText = schemaDoc.toString({ lineWidth: 0, flowCollectionPadding: true });
    const s = parseSchemaYaml(schemaText);
    if (!s.ok) {
      const offset = at(['schema']) - 1;
      return { ok: false, errors: s.errors.map((e) => ({ ...e, line: e.line + offset })) };
    }
    schema = s.schema;
  }

  const skipped: ImportReport['skipped'] = [];
  const skip = (path: ReadonlyArray<PropertyKey>, reason: string) =>
    skipped.push({ line: at(path), reason });

  const entities: Entity[] = [];
  const attributes: AttributeFact[] = [];
  const edges: Edge[] = [];
  const idOf = new Map<string, string>();

  const { entities: rawEntities, edges: rawEdges } = parsed.data.facts;
  rawEntities.forEach((e, i) => {
    const path = ['facts', 'entities', i];
    if (schema && !schema.entities[e.type]) {
      skip(path, `unknown entity type '${e.type}'`);
      return;
    }
    if (idOf.has(key(e.type, e.name))) {
      skip(path, `duplicate entity '${key(e.type, e.name)}'`);
      return;
    }
    const id = `ent-${entities.length + 1}`;
    idOf.set(key(e.type, e.name), id);
    entities.push({
      id,
      world,
      type: e.type,
      name: e.name,
      aliases: e.aliases ?? [],
      recordedAt: e.recorded_at ?? opts.now,
      retiredAt: e.retired_at ?? null,
      sourceRef: e.source ?? DEFAULT_SOURCE,
      author: (e.author ?? 'import') as FactAuthor,
      mergedInto: null,
    });
    for (const a of e.attributes ?? []) {
      attributes.push({
        id: `attr-${attributes.length + 1}`,
        world,
        entityId: id,
        key: a.key,
        value: a.value,
        validFrom: a.valid_from ?? null,
        validTo: a.valid_to ?? null,
        recordedAt: a.recorded_at ?? opts.now,
        retiredAt: a.retired_at ?? null,
        sourceRef: a.source ?? DEFAULT_SOURCE,
        author: a.author ?? 'import',
        confidence: a.confidence ?? 1,
      });
    }
  });

  // merged_into points at another entity by name, so it resolves after all entities exist.
  rawEntities.forEach((e, i) => {
    if (!e.merged_into) return;
    const self = idOf.get(key(e.type, e.name));
    const target = idOf.get(key(e.merged_into.type, e.merged_into.name));
    const ent = entities.find((x) => x.id === self);
    if (!ent) return;
    if (!target) {
      skip(
        ['facts', 'entities', i, 'merged_into'],
        `unknown entity '${key(e.merged_into.type, e.merged_into.name)}'`,
      );
      return;
    }
    ent.mergedInto = target;
  });

  rawEdges.forEach((e, i) => {
    const path = ['facts', 'edges', i];
    const def = schema?.edges[e.type];
    if (schema && !def) {
      skip(path, `unknown edge type '${e.type}'`);
      return;
    }
    const fromId = idOf.get(key(e.from.type, e.from.name));
    const toId = idOf.get(key(e.to.type, e.to.name));
    if (!fromId) {
      skip([...path, 'from'], `unknown entity '${key(e.from.type, e.from.name)}'`);
      return;
    }
    if (!toId) {
      skip([...path, 'to'], `unknown entity '${key(e.to.type, e.to.name)}'`);
      return;
    }
    if (def && !def.from.includes(e.from.type)) {
      skip([...path, 'from'], `edge '${e.type}' cannot start at type '${e.from.type}'`);
      return;
    }
    if (def && !def.to.includes(e.to.type)) {
      skip([...path, 'to'], `edge '${e.type}' cannot end at type '${e.to.type}'`);
      return;
    }
    edges.push({
      id: `edge-${edges.length + 1}`,
      world,
      type: e.type,
      fromId,
      toId,
      attrs: e.attrs ?? {},
      validFrom: e.valid_from ?? null,
      validTo: e.valid_to ?? null,
      recordedAt: e.recorded_at ?? opts.now,
      retiredAt: e.retired_at ?? null,
      sourceRef: e.source ?? DEFAULT_SOURCE,
      author: e.author ?? 'import',
      confidence: e.confidence ?? 1,
    });
  });

  return {
    ok: true,
    bundle: { schema, entities, attributes, edges },
    report: {
      entities: entities.length,
      attributes: attributes.length,
      edges: edges.length,
      skipped,
    },
  };
}
