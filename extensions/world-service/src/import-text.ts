// Text -> GraphBundle for the owner imports (`ethos world import`). One entry for the four import
// formats so a surface does not re-implement the parse and re-homing. The bundle goes to
// `WorldService.ownerImport`, which places every fact through the same vetting as a write.
// A malformed file is a result, never a throw (import-text.test.ts 'a malformed file is an error
// result').

import { randomBytes } from 'node:crypto';
import type { GraphBundle, WorldId, WorldSchema } from '@ethosagent/types';
import { z } from 'zod';
import { importCsv } from './codecs/csv';
import { importFactsYaml } from './codecs/facts-yaml';
import { importMcpJsonl } from './codecs/mcp-jsonl';

export type ImportFormat = 'facts-yaml' | 'json' | 'mcp-jsonl' | 'csv';

/** The format a file name implies, or undefined for an extension no codec reads. */
export function importFormatOf(path: string): ImportFormat | undefined {
  const lower = path.toLowerCase();
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return 'facts-yaml';
  if (lower.endsWith('.jsonl') || lower.endsWith('.ndjson')) return 'mcp-jsonl';
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.csv')) return 'csv';
  return undefined;
}

export interface ImportTextContext {
  world: WorldId;
  /** The world's schema; only the CSV mapping reads it. */
  schema: WorldSchema;
  /** Recorded as the source of imported facts. */
  by: string;
  /** ISO time stamped on every imported row. */
  now: string;
}

export type ImportTextResult =
  | { ok: true; bundle: GraphBundle; skipped: Array<{ line: number; reason: string }> }
  | { ok: false; error: string };

const AuthorZ = z.enum(['user', 'import', 'connector', 'agent']);
const BundleZ = z.object({
  entities: z.array(
    z.object({
      id: z.string(),
      world: z.string(),
      type: z.string(),
      name: z.string(),
      aliases: z.array(z.string()),
      recordedAt: z.string(),
      retiredAt: z.string().nullable(),
      sourceRef: z.string(),
      author: AuthorZ,
      mergedInto: z.string().nullable(),
    }),
  ),
  attributes: z.array(
    z.object({
      id: z.string(),
      world: z.string(),
      entityId: z.string(),
      key: z.string(),
      value: z.unknown(),
      validFrom: z.string().nullable(),
      validTo: z.string().nullable(),
      recordedAt: z.string(),
      retiredAt: z.string().nullable(),
      sourceRef: z.string(),
      author: AuthorZ,
      confidence: z.number(),
    }),
  ),
  edges: z.array(
    z.object({
      id: z.string(),
      world: z.string(),
      type: z.string(),
      fromId: z.string(),
      toId: z.string(),
      attrs: z.record(z.string(), z.unknown()),
      validFrom: z.string().nullable(),
      validTo: z.string().nullable(),
      recordedAt: z.string(),
      retiredAt: z.string().nullable(),
      sourceRef: z.string(),
      author: AuthorZ,
      confidence: z.number(),
    }),
  ),
});

function fromJson(text: string, world: WorldId): ImportTextResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  const parsed = BundleZ.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    };
  }
  const b = parsed.data;
  // Every row is re-homed to the target world, whatever world the file was exported from.
  return {
    ok: true,
    skipped: [],
    bundle: {
      schema: null,
      entities: b.entities.map((e) => ({ ...e, world })),
      attributes: b.attributes.map((a) => ({ ...a, world })),
      edges: b.edges.map((e) => ({ ...e, world })),
    },
  };
}

type CsvOk = Extract<ReturnType<typeof importCsv>, { ok: true }>;

/** CSV drafts are name-referenced; give each entity an id so `ownerImport` can resolve the links. */
function csvBundle(world: WorldId, now: string, r: CsvOk): GraphBundle {
  const idOf = new Map<string, string>();
  const key = (t: { type: string; name: string }): string => `${t.type}\u0000${t.name}`;
  const id = (p: string): string => `${p}-${randomBytes(8).toString('hex')}`;
  const bundle: GraphBundle = { schema: null, entities: [], attributes: [], edges: [] };
  const base = { world, recordedAt: now, retiredAt: null };
  for (const e of r.entities) {
    const eid = id('e');
    idOf.set(key(e), eid);
    bundle.entities.push({
      id: eid,
      type: e.type,
      name: e.name,
      aliases: [],
      sourceRef: e.sourceRef,
      author: e.author,
      mergedInto: null,
      ...base,
    });
  }
  for (const a of r.attributes) {
    const entityId = idOf.get(key(a.entity));
    if (!entityId) continue;
    bundle.attributes.push({
      id: id('a'),
      entityId,
      key: a.key,
      value: a.value,
      validFrom: null,
      validTo: null,
      sourceRef: a.sourceRef,
      author: a.author,
      confidence: a.confidence,
      ...base,
    });
  }
  for (const e of r.edges) {
    const fromId = idOf.get(key(e.from));
    const toId = idOf.get(key(e.to));
    if (!fromId || !toId) continue;
    bundle.edges.push({
      id: id('r'),
      type: e.type,
      fromId,
      toId,
      attrs: e.attrs,
      validFrom: null,
      validTo: null,
      sourceRef: e.sourceRef,
      author: e.author,
      confidence: e.confidence,
      ...base,
    });
  }
  return bundle;
}

export function bundleFromText(
  format: ImportFormat,
  text: string,
  ctx: ImportTextContext,
): ImportTextResult {
  switch (format) {
    case 'facts-yaml': {
      const r = importFactsYaml(text, ctx.world, { now: ctx.now });
      return r.ok
        ? { ok: true, bundle: r.bundle, skipped: [] }
        : { ok: false, error: r.errors.map((e) => `line ${e.line}: ${e.message}`).join('; ') };
    }
    case 'mcp-jsonl':
      return {
        ok: true,
        bundle: importMcpJsonl(text, { world: ctx.world, sourceRef: ctx.by, now: ctx.now }).bundle,
        skipped: [],
      };
    case 'json':
      return fromJson(text, ctx.world);
    case 'csv': {
      const r = importCsv(text, ctx.schema, { sourceName: ctx.by });
      if (!r.ok) {
        return { ok: false, error: r.issues.map((i) => `${i.column}: ${i.reason}`).join('; ') };
      }
      return { ok: true, bundle: csvBundle(ctx.world, ctx.now, r), skipped: [...r.skipped] };
    }
  }
}
