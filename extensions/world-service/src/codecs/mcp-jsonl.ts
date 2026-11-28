// Codec between a GraphBundle and the JSONL file of the reference MCP memory
// server (@modelcontextprotocol/server-memory@2.1.1, dist/index.js loadGraph /
// saveGraph). One JSON object per line:
//   {"type":"entity","name":…,"entityType":…,"observations":[…]}
//   {"type":"relation","from":…,"to":…,"relationType":…}
// Entities are keyed by name; relations carry no metadata of their own.
//
// Ethos metadata travels as observations with the fixed prefix `ethos:`.
//   `ethos:alias=<s>`, `ethos:author=<a>`, `ethos:source=<s>`   entity level
//   `ethos:attr:<key>=<json>`                                   opens an attribute
//   `ethos:valid_from=` / `valid_to=` / `author=` / `source=`   attach to the
//       attribute opened last, or to the entity when none is open yet
//   `ethos:edge=<json {type,to,validFrom,validTo,author,source,attrs}>`
//       on the from-entity, one per exported edge
// Observations without the prefix import as a `note` attribute.
//
// Limitations: another agent that reorders observations can detach metadata
// from its attribute; attribute `confidence` and `recordedAt` do not travel
// (import uses 1 and ctx.now). Duplicate entity names get a ` #n` suffix on
// export. Pinned by __tests__/mcp-jsonl.test.ts.

import type {
  AttributeFact,
  Edge,
  Entity,
  FactAuthor,
  GraphBundle,
  ImportReport,
  WorldId,
} from '@ethosagent/types';
import { z } from 'zod';

const PREFIX = 'ethos:';
const AUTHORS: readonly string[] = ['user', 'import', 'connector', 'agent'];

const EntityLine = z.object({
  type: z.literal('entity'),
  name: z.string().min(1),
  entityType: z.string().min(1),
  observations: z.array(z.string()),
});
const RelationLine = z.object({
  type: z.literal('relation'),
  from: z.string(),
  to: z.string(),
  relationType: z.string().min(1),
});
const EdgeMeta = z.object({
  type: z.string(),
  to: z.string(),
  validFrom: z.string().nullable().optional(),
  validTo: z.string().nullable().optional(),
  author: z.string().optional(),
  source: z.string().optional(),
  attrs: z.record(z.string(), z.unknown()).optional(),
});

export interface McpImportContext {
  world: WorldId;
  /** sourceRef for everything the file does not override. */
  sourceRef: string;
  /** ISO timestamp used as recordedAt. */
  now: string;
  /** Fact-id generator; defaults to crypto.randomUUID. */
  newId?: () => string;
}

function asAuthor(s: string | undefined, fallback: FactAuthor): FactAuthor {
  return s !== undefined && AUTHORS.includes(s) ? (s as FactAuthor) : fallback;
}

export function exportMcpJsonl(bundle: GraphBundle): string {
  const entities = bundle.entities.filter((e) => e.retiredAt === null && e.mergedInto === null);
  const names = new Map<string, string>(); // entity id -> unique line name
  const taken = new Set<string>();
  for (const e of entities) {
    let name = e.name;
    for (let n = 2; taken.has(name); n++) name = `${e.name} #${n}`;
    taken.add(name);
    names.set(e.id, name);
  }
  const attrsBy = new Map<string, AttributeFact[]>();
  for (const a of bundle.attributes) {
    if (a.retiredAt !== null) continue;
    const list = attrsBy.get(a.entityId) ?? [];
    list.push(a);
    attrsBy.set(a.entityId, list);
  }
  const edges = bundle.edges.filter(
    (e) => e.retiredAt === null && names.has(e.fromId) && names.has(e.toId),
  );
  const out: string[] = [];
  for (const e of entities) {
    const obs: string[] = [`${PREFIX}author=${e.author}`, `${PREFIX}source=${e.sourceRef}`];
    for (const alias of e.aliases) obs.push(`${PREFIX}alias=${alias}`);
    for (const a of attrsBy.get(e.id) ?? []) {
      obs.push(`${PREFIX}attr:${a.key}=${JSON.stringify(a.value)}`);
      if (a.validFrom !== null) obs.push(`${PREFIX}valid_from=${a.validFrom}`);
      if (a.validTo !== null) obs.push(`${PREFIX}valid_to=${a.validTo}`);
      obs.push(`${PREFIX}author=${a.author}`, `${PREFIX}source=${a.sourceRef}`);
    }
    for (const r of edges.filter((x) => x.fromId === e.id)) {
      obs.push(
        `${PREFIX}edge=${JSON.stringify({
          type: r.type,
          to: names.get(r.toId),
          validFrom: r.validFrom,
          validTo: r.validTo,
          author: r.author,
          source: r.sourceRef,
          attrs: r.attrs,
        })}`,
      );
    }
    out.push(
      JSON.stringify({
        type: 'entity',
        name: names.get(e.id),
        entityType: e.type,
        observations: obs,
      }),
    );
  }
  for (const r of edges) {
    out.push(
      JSON.stringify({
        type: 'relation',
        from: names.get(r.fromId),
        to: names.get(r.toId),
        relationType: r.type,
      }),
    );
  }
  return out.length === 0 ? '' : `${out.join('\n')}\n`;
}

export function importMcpJsonl(
  text: string,
  ctx: McpImportContext,
): { bundle: GraphBundle; report: ImportReport } {
  const newId = ctx.newId ?? (() => crypto.randomUUID());
  const entities: Entity[] = [];
  const attributes: AttributeFact[] = [];
  const edges: Edge[] = [];
  const skipped: ImportReport['skipped'] = [];
  const byName = new Map<string, Entity>();
  const pendingEdgeMeta: Array<{ from: Entity; meta: z.infer<typeof EdgeMeta> }> = [];
  const relations: Array<{ line: number; from: string; to: string; type: string }> = [];

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    if (raw.trim() === '') continue;
    const line = i + 1;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      skipped.push({ line, reason: 'invalid JSON' });
      continue;
    }
    const rec = typeof json === 'object' && json !== null ? (json as { type?: unknown }) : {};
    if (rec.type === 'entity') {
      const p = EntityLine.safeParse(json);
      if (!p.success) {
        skipped.push({ line, reason: 'invalid entity record' });
        continue;
      }
      if (byName.has(p.data.name)) {
        skipped.push({ line, reason: `duplicate entity "${p.data.name}"` });
        continue;
      }
      const entity: Entity = {
        id: newId(),
        world: ctx.world,
        type: p.data.entityType,
        name: p.data.name,
        aliases: [],
        recordedAt: ctx.now,
        retiredAt: null,
        sourceRef: ctx.sourceRef,
        author: 'import',
        mergedInto: null,
      };
      byName.set(entity.name, entity);
      entities.push(entity);
      let open: AttributeFact | null = null;
      const newAttr = (key: string, value: unknown): AttributeFact => {
        const a: AttributeFact = {
          id: newId(),
          world: ctx.world,
          entityId: entity.id,
          key,
          value,
          validFrom: null,
          validTo: null,
          recordedAt: ctx.now,
          retiredAt: null,
          sourceRef: ctx.sourceRef,
          author: 'import',
          confidence: 1,
        };
        attributes.push(a);
        return a;
      };
      for (const o of p.data.observations) {
        if (!o.startsWith(PREFIX)) {
          open = newAttr('note', o);
          continue;
        }
        const body = o.slice(PREFIX.length);
        const eq = body.indexOf('=');
        const head = eq < 0 ? body : body.slice(0, eq);
        const val = eq < 0 ? '' : body.slice(eq + 1);
        if (head.startsWith('attr:')) {
          try {
            open = newAttr(head.slice('attr:'.length), JSON.parse(val));
          } catch {
            open = newAttr('note', o);
          }
        } else if (head === 'alias') {
          entity.aliases.push(val);
        } else if (head === 'author') {
          const a = asAuthor(val, 'import');
          if (open) open.author = a;
          else entity.author = a;
        } else if (head === 'source') {
          if (open) open.sourceRef = val;
          else entity.sourceRef = val;
        } else if (head === 'valid_from' || head === 'valid_to') {
          if (open) {
            if (head === 'valid_from') open.validFrom = val;
            else open.validTo = val;
          }
        } else if (head === 'edge') {
          try {
            const m = EdgeMeta.safeParse(JSON.parse(val));
            if (m.success) pendingEdgeMeta.push({ from: entity, meta: m.data });
          } catch {
            // Unparseable edge metadata only loses dates; the relation line still imports.
          }
        } else {
          open = newAttr('note', o);
        }
      }
    } else if (rec.type === 'relation') {
      const p = RelationLine.safeParse(json);
      if (!p.success) {
        skipped.push({ line, reason: 'invalid relation record' });
        continue;
      }
      relations.push({ line, from: p.data.from, to: p.data.to, type: p.data.relationType });
    } else {
      skipped.push({ line, reason: 'unknown record type' });
    }
  }

  // Relations resolve after all entities so file order does not matter.
  for (const r of relations) {
    const from = byName.get(r.from);
    const to = byName.get(r.to);
    if (!from || !to) {
      const missing = from ? r.to : r.from;
      skipped.push({ line: r.line, reason: `relation to unknown entity "${missing}"` });
      continue;
    }
    const mi = pendingEdgeMeta.findIndex(
      (m) => m.from === from && m.meta.type === r.type && m.meta.to === r.to,
    );
    const meta = mi >= 0 ? pendingEdgeMeta.splice(mi, 1)[0]?.meta : undefined;
    edges.push({
      id: newId(),
      world: ctx.world,
      type: r.type,
      fromId: from.id,
      toId: to.id,
      attrs: meta?.attrs ?? {},
      validFrom: meta?.validFrom ?? null,
      validTo: meta?.validTo ?? null,
      recordedAt: ctx.now,
      retiredAt: null,
      sourceRef: meta?.source ?? ctx.sourceRef,
      author: asAuthor(meta?.author, 'import'),
      confidence: 1,
    });
  }
  skipped.sort((a, b) => a.line - b.line);
  return {
    bundle: { schema: null, entities, attributes, edges },
    report: {
      entities: entities.length,
      attributes: attributes.length,
      edges: edges.length,
      skipped,
    },
  };
}
