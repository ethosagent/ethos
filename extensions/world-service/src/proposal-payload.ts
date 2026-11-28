// The JSON a proposal row carries, and its validation on the way back out.
// WorldService writes these shapes into `proposals.payload_json` and
// `acceptProposal` reads them with `safeParse` (never an `as` cast): a row
// edited by hand or written by an older version fails closed as a refusal.
// Pinned by write-routing.test.ts 'accepting a shared-world proposal applies it
// with the original author and records decided_by'.

import type { FactInput } from '@ethosagent/types';
import { z } from 'zod';
import type { SchemaChange } from './schema-diff';

const author = z.enum(['user', 'import', 'connector', 'agent']);
const attrSpec = z.object({
  type: z.enum(['string', 'int', 'number', 'bool', 'date', 'url']),
  min: z.number().optional(),
  max: z.number().optional(),
  enum: z.array(z.string()).optional(),
});
const attrs = z.record(z.string(), attrSpec);
const on = z.union([z.object({ entity: z.string() }), z.object({ edge: z.string() })]);
const kind = z.enum(['entity', 'edge']);

export const schemaChangeZ = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add_entity_type'), type: z.string(), attrs: attrs.optional() }),
  z.object({
    op: z.literal('add_edge_type'),
    type: z.string(),
    from: z.array(z.string()),
    to: z.array(z.string()),
    attrs: attrs.optional(),
    unique: z.enum(['from', 'to']).optional(),
  }),
  z.object({ op: z.literal('add_attribute'), on, key: z.string(), spec: attrSpec }),
  z.object({
    op: z.literal('add_allowed_pair'),
    edge: z.string(),
    from: z.string().optional(),
    to: z.string().optional(),
  }),
  z.object({ op: z.literal('rename_type'), kind, from: z.string(), to: z.string() }),
  z.object({ op: z.literal('rename_attribute'), on, from: z.string(), to: z.string() }),
  z.object({
    op: z.literal('merge_types'),
    kind: z.literal('entity'),
    from: z.string(),
    into: z.string(),
  }),
  z.object({ op: z.literal('remove_type'), kind, type: z.string() }),
]);

const factZ = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('entity'),
    type: z.string(),
    name: z.string(),
    aliases: z.array(z.string()).optional(),
    sourceRef: z.string(),
    author,
  }),
  z.object({
    kind: z.literal('attribute'),
    entityId: z.string(),
    key: z.string(),
    value: z.unknown(),
    validFrom: z.string().optional(),
    sourceRef: z.string(),
    author,
    confidence: z.number(),
  }),
  z.object({
    kind: z.literal('edge'),
    type: z.string(),
    fromId: z.string(),
    toId: z.string(),
    attrs: z.record(z.string(), z.unknown()).optional(),
    validFrom: z.string().optional(),
    sourceRef: z.string(),
    author,
    confidence: z.number(),
  }),
]);

/** An entity named by type and name: how an import proposal points at an entity that does not exist yet. */
export interface EntityRef {
  type: string;
  name: string;
}
const refZ = z.object({ type: z.string(), name: z.string() });

export interface AssertPayload {
  fact: FactInput;
  /** Live facts the fact replaces: closed on accept (a conflict, or a unique collision). */
  closes: string[];
  /** Endpoints to resolve by name on accept, for facts imported before their entity was accepted. */
  refs: { entityId?: EntityRef; fromId?: EntityRef; toId?: EntityRef };
}

const assertZ = z.object({
  fact: factZ,
  closes: z.array(z.string()).default([]),
  refs: z
    .object({ entityId: refZ.optional(), fromId: refZ.optional(), toId: refZ.optional() })
    .default({}),
});

/** `value: z.unknown()` makes the key optional in the inferred type; rebuild so FactInput is exact. */
function toFact(f: z.infer<typeof factZ>): FactInput {
  if (f.kind === 'attribute') {
    return {
      kind: 'attribute',
      entityId: f.entityId,
      key: f.key,
      value: f.value,
      ...(f.validFrom !== undefined ? { validFrom: f.validFrom } : {}),
      sourceRef: f.sourceRef,
      author: f.author,
      confidence: f.confidence,
    };
  }
  return f;
}

export function parseAssertPayload(raw: unknown): AssertPayload | null {
  const p = assertZ.safeParse(raw);
  return p.success ? { fact: toFact(p.data.fact), closes: p.data.closes, refs: p.data.refs } : null;
}

export interface ClosePayload {
  factId: string;
  validTo: string;
  sourceRef: string;
}
const closeZ = z.object({ factId: z.string(), validTo: z.string(), sourceRef: z.string() });
export function parseClosePayload(raw: unknown): ClosePayload | null {
  const p = closeZ.safeParse(raw);
  return p.success ? p.data : null;
}

const schemaPayloadZ = z.object({ change: schemaChangeZ });
export function parseSchemaPayload(raw: unknown): SchemaChange | null {
  const p = schemaPayloadZ.safeParse(raw);
  return p.success ? p.data.change : null;
}
