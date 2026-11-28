// schema.yaml model: parse, validate, serialise. Pure: no I/O, no clock. The
// only writer of the file is WorldSchemaService.apply (schema-service.ts).
//
// `WorldSchema` (packages/types/src/world-graph.ts) is the contract shape and
// has no `sensitive` flag and no changelog. Both are kept here as extension
// fields next to it: `sensitive` is a list of `entity:<Type>.<attr>` /
// `edge:<type>.<attr>` keys (plan Task 2.4 reads it so the agent can never
// write such an attribute), and the changelog is the file's audit trail.
// The extension never reaches the backend: `parseSchemaYaml` strips it from
// `schema`, pinned by schema-model.test.ts ('canonical and short edge forms
// parse; ...').

import type { AttrSpec, WorldSchema } from '@ethosagent/types';
import { Document, isMap, isNode, isSeq, LineCounter, parseDocument } from 'yaml';
import { z } from 'zod';

export interface ChangelogEntry {
  v: number;
  by: string;
  at: string;
  change: string;
  reason?: string;
}

export interface SchemaIssue {
  /** 1-based. */
  line: number;
  /** 1-based; present when the YAML parser knows it. */
  column?: number;
  message: string;
}

/** A parsed schema.yaml: the contract schema plus the world-service extension fields. */
export interface SchemaDoc {
  schema: WorldSchema;
  /** `entity:Person.email` / `edge:member_of.role` */
  sensitive: string[];
  changelog: ChangelogEntry[];
}

export type ParseSchemaResult = ({ ok: true } & SchemaDoc) | { ok: false; errors: SchemaIssue[] };

export const sensitiveKey = (on: 'entity' | 'edge', type: string, attr: string): string =>
  `${on}:${type}.${attr}`;

const NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const name = z.string().regex(NAME, 'must start with a letter and use letters, digits and _');

const attrSpecZ = z
  .object({
    type: z.enum(['string', 'int', 'number', 'bool', 'date', 'url']),
    min: z.number().optional(),
    max: z.number().optional(),
    enum: z.array(z.string()).optional(),
    sensitive: z.boolean().optional(),
  })
  .strict();

const attrsZ = z.record(name, attrSpecZ).default({});

const entityZ = z.preprocess((v) => (v === null ? {} : v), z.object({ attrs: attrsZ }).strict());

const edgeObjectZ = z
  .object({
    from: z.array(name).min(1),
    to: z.array(name).min(1),
    attrs: attrsZ,
    unique: z.enum(['from', 'to']).optional(),
  })
  .strict();

const SHORT_EDGE = /^\s*([A-Za-z][A-Za-z0-9_]*)\s*->\s*([A-Za-z][A-Za-z0-9_]*)\s*$/;

const changelogZ = z
  .object({
    v: z.number().int().min(1),
    by: z.string().min(1),
    at: z.string().min(1),
    change: z.string().min(1),
    reason: z.string().optional(),
  })
  .strict();

const fileZ = z
  .object({
    version: z.number().int().min(1),
    entities: z.record(name, entityZ).default({}),
    edges: z.record(name, z.union([z.string(), edgeObjectZ])).default({}),
    changelog: z.array(changelogZ).default([]),
  })
  .strict();

type YamlDoc = ReturnType<typeof parseDocument>;

function posOf(doc: YamlDoc, lc: LineCounter, path: ReadonlyArray<PropertyKey>): [number, number] {
  const p = [...path];
  for (;;) {
    const node = p.length === 0 ? doc.contents : doc.getIn(p, true);
    if (isNode(node) && node.range) {
      const pos = lc.linePos(node.range[0]);
      return [pos.line, pos.col];
    }
    if (p.length === 0) return [1, 1];
    p.pop();
  }
}

const STRUCTURED_HINT =
  'use the structured form: { from: [A], to: [B], attrs: { key: { type: int } } }';

export function parseSchemaYaml(text: string): ParseSchemaResult {
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc, uniqueKeys: true });
  if (doc.errors.length > 0) {
    return {
      ok: false,
      errors: doc.errors.map((e) => {
        const first = (e.message.split('\n')[0] ?? e.code).replace(
          / at line \d+, column \d+:?$/,
          '',
        );
        const message =
          e.code === 'BLOCK_AS_IMPLICIT_KEY' || e.code === 'MULTILINE_IMPLICIT_KEY'
            ? `${first} (an edge with attributes cannot be written as "A -> B { k: v }"; ${STRUCTURED_HINT})`
            : first;
        return { line: e.linePos?.[0].line ?? 1, column: e.linePos?.[0].col, message };
      }),
    };
  }
  const at = (path: ReadonlyArray<PropertyKey>) => posOf(doc, lc, path);
  const issue = (path: ReadonlyArray<PropertyKey>, message: string): SchemaIssue => {
    const [line, column] = at(path);
    return { line, column, message };
  };

  const parsed = fileZ.safeParse(doc.toJS());
  if (!parsed.success) {
    const errors: SchemaIssue[] = [];
    for (const i of parsed.error.issues) {
      if (i.code === 'unrecognized_keys') {
        for (const key of i.keys) {
          errors.push(issue([...i.path, key], `unknown key "${key}"`));
        }
      } else {
        const where = i.path.length > 0 ? `${i.path.join('.')}: ` : '';
        errors.push(issue(i.path, `${where}${i.message}`));
      }
    }
    return { ok: false, errors };
  }

  const file = parsed.data;
  const errors: SchemaIssue[] = [];
  const sensitive: string[] = [];
  const schema: WorldSchema = { version: file.version, entities: {}, edges: {} };

  const attrsOut = (
    on: 'entity' | 'edge',
    type: string,
    attrs: Record<string, z.infer<typeof attrSpecZ>>,
    path: ReadonlyArray<PropertyKey>,
  ): Record<string, AttrSpec> => {
    const out: Record<string, AttrSpec> = {};
    for (const [key, raw] of Object.entries(attrs)) {
      const { sensitive: flag, ...spec } = raw;
      if (spec.min !== undefined && spec.max !== undefined && spec.min > spec.max) {
        errors.push(issue([...path, key], `${type}.${key}: min is above max`));
      }
      if (flag === true) sensitive.push(sensitiveKey(on, type, key));
      out[key] = spec;
    }
    return out;
  };

  for (const [type, ent] of Object.entries(file.entities)) {
    const e = ent as { attrs: Record<string, z.infer<typeof attrSpecZ>> };
    schema.entities[type] = {
      attrs: attrsOut('entity', type, e.attrs, ['entities', type, 'attrs']),
    };
  }

  for (const [type, def] of Object.entries(file.edges)) {
    const path = ['edges', type];
    let from: string[];
    let to: string[];
    let attrs: Record<string, AttrSpec> = {};
    let unique: 'from' | 'to' | undefined;
    if (typeof def === 'string') {
      const m = SHORT_EDGE.exec(def);
      if (!m) {
        errors.push(
          issue(
            path,
            def.includes('{')
              ? `edge '${type}': a short "A -> B" edge cannot carry attributes; ${STRUCTURED_HINT}`
              : `edge '${type}': expected "From -> To" or the structured form`,
          ),
        );
        continue;
      }
      from = [m[1] as string];
      to = [m[2] as string];
    } else {
      from = def.from;
      to = def.to;
      attrs = attrsOut('edge', type, def.attrs, [...path, 'attrs']);
      unique = def.unique;
    }
    for (const end of [...from, ...to]) {
      if (!schema.entities[end]) {
        errors.push(issue(path, `edge '${type}': unknown entity type '${end}'`));
      }
    }
    schema.edges[type] = { from, to, attrs, ...(unique ? { unique } : {}) };
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, schema, sensitive, changelog: file.changelog };
}

function attrOut(spec: AttrSpec, sensitive: boolean): Record<string, unknown> {
  return { ...spec, ...(sensitive ? { sensitive: true } : {}) };
}

/** schema.yaml text for `doc`. Parsing it back yields an equal `SchemaDoc` (round-trip test). */
export function serializeSchemaYaml(doc: SchemaDoc): string {
  const sens = new Set(doc.sensitive);
  const attrsFor = (on: 'entity' | 'edge', type: string, attrs: Record<string, AttrSpec>) =>
    Object.fromEntries(
      Object.entries(attrs).map(([k, s]) => [k, attrOut(s, sens.has(sensitiveKey(on, type, k)))]),
    );

  const entities = Object.fromEntries(
    Object.entries(doc.schema.entities).map(([t, e]) => [
      t,
      { attrs: attrsFor('entity', t, e.attrs) },
    ]),
  );
  const edges = Object.fromEntries(
    Object.entries(doc.schema.edges).map(([t, e]) => {
      const short =
        e.from.length === 1 && e.to.length === 1 && Object.keys(e.attrs).length === 0 && !e.unique;
      return [
        t,
        short
          ? `${e.from[0]} -> ${e.to[0]}`
          : {
              from: e.from,
              to: e.to,
              ...(Object.keys(e.attrs).length > 0 ? { attrs: attrsFor('edge', t, e.attrs) } : {}),
              ...(e.unique ? { unique: e.unique } : {}),
            },
      ];
    }),
  );
  const out = {
    version: doc.schema.version,
    entities,
    edges,
    ...(doc.changelog.length > 0 ? { changelog: doc.changelog } : {}),
  };
  // Block style at the top, flow style for each type definition and changelog row,
  // like the canonical example in the plan.
  const yamlDoc = new Document(out);
  for (const section of ['entities', 'edges', 'changelog']) {
    const node = yamlDoc.get(section, true);
    if (isMap(node)) {
      for (const item of node.items) setFlow(item.value);
    } else if (isSeq(node)) {
      for (const item of node.items) setFlow(item);
    }
  }
  return yamlDoc.toString({ lineWidth: 0, flowCollectionPadding: true });
}

function setFlow(node: unknown): void {
  if (isMap(node)) {
    node.flow = true;
    for (const item of node.items) setFlow(item.value);
  } else if (isSeq(node)) {
    node.flow = true;
    for (const item of node.items) setFlow(item);
  }
}

/** Key-sorted JSON, so two schemas compare equal whatever order their types were written in. */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, x]) => [k, sort(x)]),
      );
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

/** The part of a schema.yaml that is content: everything but the version and the changelog. */
export function schemaShape(doc: Pick<SchemaDoc, 'schema' | 'sensitive'>): string {
  return canonicalJson({
    entities: doc.schema.entities,
    edges: doc.schema.edges,
    sensitive: [...doc.sensitive].sort(),
  });
}
