// In-memory fakes shared by the world-service tests. world-service never
// imports world-sqlite (dependency law), so every test that needs a graph
// backend uses `FakeWorldGraphProvider`; a test that needs `Storage` uses
// `FakeStorage`. Later tasks (2.4 onwards) reuse both.

import type {
  AttributeFact,
  Edge,
  Entity,
  FactAuthor,
  FactInput,
  Facts,
  GraphBundle,
  GraphQuery,
  ImportReport,
  Storage,
  StorageDirEntry,
  Subgraph,
  WorldGraphProvider,
  WorldId,
  WorldProviderCapabilities,
  WorldSchema,
  WriteResult,
} from '@ethosagent/types';

export class FakeStorage implements Storage {
  readonly files = new Map<string, string>();
  readonly dirs = new Set<string>();
  /** Every writeAtomic path, in order, so a test can assert who wrote what. */
  readonly atomicWrites: string[] = [];

  async read(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }
  async readBytes(path: string): Promise<Uint8Array | null> {
    const t = this.files.get(path);
    return t === undefined ? null : new TextEncoder().encode(t);
  }
  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.dirs.has(path);
  }
  async mtime(path: string): Promise<number | null> {
    return this.files.has(path) ? 0 : null;
  }
  async list(dir: string): Promise<string[]> {
    return (await this.listEntries(dir)).map((e) => e.name);
  }
  async listEntries(dir: string): Promise<StorageDirEntry[]> {
    const prefix = dir.endsWith('/') ? dir : `${dir}/`;
    const names = new Set<string>();
    for (const f of this.files.keys()) {
      if (f.startsWith(prefix)) names.add(f.slice(prefix.length).split('/')[0] ?? '');
    }
    return [...names].map((name) => ({ name, isDir: false }));
  }
  async write(path: string, content: string | Uint8Array): Promise<void> {
    this.files.set(path, typeof content === 'string' ? content : new TextDecoder().decode(content));
  }
  async append(path: string, content: string): Promise<void> {
    this.files.set(path, (this.files.get(path) ?? '') + content);
  }
  async writeAtomic(path: string, content: string | Uint8Array): Promise<void> {
    this.atomicWrites.push(path);
    await this.write(path, content);
  }
  async mkdir(dir: string): Promise<void> {
    this.dirs.add(dir);
  }
  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }
  async rename(from: string, to: string): Promise<void> {
    const t = this.files.get(from);
    if (t !== undefined) {
      this.files.set(to, t);
      this.files.delete(from);
    }
  }
  async chmod(): Promise<void> {}
}

interface Held {
  entities: Entity[];
  attributes: AttributeFact[];
  edges: Edge[];
  schema: WorldSchema | null;
}

const isLive = (f: { retiredAt: string | null; validTo?: string | null }): boolean =>
  f.retiredAt === null && (f.validTo ?? null) === null;

/**
 * A faithful-enough in-memory WorldGraphProvider: it keeps the real store's
 * rules that the service relies on (assert checks entity and edge types
 * against the stored schema; retire and close refuse an already-ended fact;
 * `retire` takes attributes and edges only, as the real one does).
 */
export class FakeWorldGraphProvider implements WorldGraphProvider {
  private readonly worlds = new Map<string, Held>();
  private seq = 0;
  clock = '2026-11-28T00:00:00.000Z';
  /** Every assert call, in order. */
  readonly asserts: Array<{ world: WorldId; facts: FactInput[] }> = [];
  /** Every applySchema call, in order. */
  readonly appliedSchemas: Array<{ world: WorldId; schema: WorldSchema }> = [];

  private held(world: WorldId): Held {
    let h = this.worlds.get(world);
    if (!h) {
      h = { entities: [], attributes: [], edges: [], schema: null };
      this.worlds.set(world, h);
    }
    return h;
  }

  private id(prefix: string): string {
    this.seq++;
    return `${prefix}-${String(this.seq).padStart(16, '0')}`;
  }

  /** Test helper: put a live entity straight in. */
  seedEntity(world: WorldId, type: string, name: string, author: FactAuthor = 'user'): Entity {
    const e: Entity = {
      id: this.id('e'),
      world,
      type,
      name,
      aliases: [],
      recordedAt: this.clock,
      retiredAt: null,
      sourceRef: 'seed',
      author,
      mergedInto: null,
    };
    this.held(world).entities.push(e);
    return e;
  }

  seedEdge(
    world: WorldId,
    type: string,
    fromId: string,
    toId: string,
    opts: { validFrom?: string; attrs?: Record<string, unknown>; author?: FactAuthor } = {},
  ): Edge {
    const e: Edge = {
      id: this.id('r'),
      world,
      type,
      fromId,
      toId,
      attrs: opts.attrs ?? {},
      validFrom: opts.validFrom ?? null,
      validTo: null,
      recordedAt: this.clock,
      retiredAt: null,
      sourceRef: 'seed',
      author: opts.author ?? 'user',
      confidence: 1,
    };
    this.held(world).edges.push(e);
    return e;
  }

  seedAttribute(
    world: WorldId,
    entityId: string,
    key: string,
    value: unknown,
    opts: { validFrom?: string; author?: FactAuthor } = {},
  ): AttributeFact {
    const a: AttributeFact = {
      id: this.id('a'),
      world,
      entityId,
      key,
      value,
      validFrom: opts.validFrom ?? null,
      validTo: null,
      recordedAt: this.clock,
      retiredAt: null,
      sourceRef: 'seed',
      author: opts.author ?? 'user',
      confidence: 1,
    };
    this.held(world).attributes.push(a);
    return a;
  }

  /** Everything ever stored, retired rows included. */
  all(world: WorldId): Held {
    return this.held(world);
  }

  async getSchema(world: WorldId): Promise<WorldSchema | null> {
    return this.held(world).schema;
  }

  async applySchema(world: WorldId, schema: WorldSchema): Promise<WriteResult> {
    this.held(world).schema = structuredClone(schema);
    this.appliedSchemas.push({ world, schema: structuredClone(schema) });
    return { ok: true, ids: [] };
  }

  async assert(world: WorldId, facts: FactInput[]): Promise<WriteResult> {
    const h = this.held(world);
    this.asserts.push({ world, facts });
    const typeOf = (id: string) =>
      h.entities.find((e) => e.id === id && e.retiredAt === null)?.type;
    // Validate the whole batch first: a refused batch writes nothing.
    for (const f of facts) {
      if (f.sourceRef.trim() === '') return { ok: false, code: 'invalid', reason: 'sourceRef' };
      if (f.kind === 'entity' && h.schema && !h.schema.entities[f.type]) {
        return {
          ok: false,
          code: 'schema',
          reason: `entity type '${f.type}' is not in the schema`,
        };
      }
      if (f.kind === 'attribute') {
        const t = typeOf(f.entityId);
        if (t === undefined) return { ok: false, code: 'not_found', reason: f.entityId };
        if (h.schema && !h.schema.entities[t]?.attrs[f.key]) {
          return { ok: false, code: 'schema', reason: `${t}.${f.key} is not in the schema` };
        }
      }
      if (f.kind === 'edge') {
        const ft = typeOf(f.fromId);
        const tt = typeOf(f.toId);
        if (ft === undefined || tt === undefined) {
          return { ok: false, code: 'not_found', reason: 'endpoint' };
        }
        const spec = h.schema?.edges[f.type];
        if (h.schema && (!spec?.from.includes(ft) || !spec.to.includes(tt))) {
          return { ok: false, code: 'schema', reason: `edge '${f.type}' ${ft} -> ${tt}` };
        }
      }
    }
    const ids: string[] = [];
    for (const f of facts) {
      if (f.kind === 'entity') {
        const e: Entity = {
          id: this.id('e'),
          world,
          type: f.type,
          name: f.name,
          aliases: f.aliases ?? [],
          recordedAt: this.clock,
          retiredAt: null,
          sourceRef: f.sourceRef,
          author: f.author,
          mergedInto: null,
        };
        h.entities.push(e);
        ids.push(e.id);
      } else if (f.kind === 'attribute') {
        const a: AttributeFact = {
          id: this.id('a'),
          world,
          entityId: f.entityId,
          key: f.key,
          value: f.value,
          validFrom: f.validFrom ?? null,
          validTo: null,
          recordedAt: this.clock,
          retiredAt: null,
          sourceRef: f.sourceRef,
          author: f.author,
          confidence: f.confidence,
        };
        h.attributes.push(a);
        ids.push(a.id);
      } else {
        const r: Edge = {
          id: this.id('r'),
          world,
          type: f.type,
          fromId: f.fromId,
          toId: f.toId,
          attrs: f.attrs ?? {},
          validFrom: f.validFrom ?? null,
          validTo: null,
          recordedAt: this.clock,
          retiredAt: null,
          sourceRef: f.sourceRef,
          author: f.author,
          confidence: f.confidence,
        };
        h.edges.push(r);
        ids.push(r.id);
      }
    }
    return { ok: true, ids };
  }

  async retire(world: WorldId, factId: string): Promise<WriteResult> {
    const h = this.held(world);
    const fact = [...h.attributes, ...h.edges].find((f) => f.id === factId);
    if (!fact) return { ok: false, code: 'not_found', reason: factId };
    if (fact.retiredAt !== null) return { ok: false, code: 'closed', reason: 'already retired' };
    fact.retiredAt = this.clock;
    return { ok: true, ids: [factId] };
  }

  async close(world: WorldId, factId: string, validTo: string): Promise<WriteResult> {
    const h = this.held(world);
    const fact = [...h.attributes, ...h.edges].find((f) => f.id === factId);
    if (!fact) return { ok: false, code: 'not_found', reason: factId };
    if (fact.validTo !== null) return { ok: false, code: 'closed', reason: 'already closed' };
    fact.validTo = validTo;
    return { ok: true, ids: [factId] };
  }

  async query(world: WorldId, q: GraphQuery): Promise<Facts> {
    const h = this.held(world);
    if (q.kind === 'entities') {
      const all = h.entities.filter(
        (e) =>
          e.retiredAt === null &&
          (!q.types || q.types.includes(e.type)) &&
          (q.text === undefined || e.name.toLowerCase().includes(q.text.toLowerCase())),
      );
      const entities = all.slice(0, q.limit);
      const ids = new Set(entities.map((e) => e.id));
      return {
        entities,
        attributes: h.attributes.filter((a) => ids.has(a.entityId) && isLive(a)),
        edges: [],
        truncated: all.length > q.limit,
      };
    }
    if (q.kind === 'edges') {
      const all = h.edges.filter(
        (e) =>
          (q.includeClosed ? e.retiredAt === null : isLive(e)) &&
          (!q.types || q.types.includes(e.type)) &&
          (q.fromId === undefined || e.fromId === q.fromId) &&
          (q.toId === undefined || e.toId === q.toId),
      );
      return {
        entities: [],
        attributes: [],
        edges: all.slice(0, q.limit),
        truncated: all.length > q.limit,
      };
    }
    return { entities: [], attributes: [], edges: [], paths: [], truncated: false };
  }

  async neighbours(_world: WorldId, entityId: string, hops: number): Promise<Subgraph> {
    return { entities: [], attributes: [], edges: [], truncated: false, centre: entityId, hops };
  }

  async history(world: WorldId, entityId: string) {
    const h = this.held(world);
    return {
      attributes: h.attributes.filter((a) => a.entityId === entityId),
      edges: h.edges.filter((e) => e.fromId === entityId || e.toId === entityId),
    };
  }

  async changes() {
    return [];
  }

  async import(): Promise<ImportReport> {
    return { entities: 0, attributes: 0, edges: 0, skipped: [] };
  }

  async export(world: WorldId): Promise<GraphBundle> {
    const h = this.held(world);
    return { schema: h.schema, entities: h.entities, attributes: h.attributes, edges: h.edges };
  }

  async purge(): Promise<{ removed: number }> {
    return { removed: 0 };
  }

  capabilities(): WorldProviderCapabilities {
    return { bitemporal: true, fullText: false, vector: false, maxHops: 3 };
  }
}
