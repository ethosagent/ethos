import { dirname, join } from 'node:path';
import type {
  Edge,
  FactInput,
  Storage,
  WorldGraphProvider,
  WorldId,
  WorldSchema,
} from '@ethosagent/types';
import { z } from 'zod';
import type { ResolvedWorld } from './access';
import { worldSlug } from './ids';
import {
  applyChange,
  classifySchemaChange,
  describeChange,
  type SchemaChange,
  unionSchema,
} from './schema-diff';
import {
  type ChangelogEntry,
  parseSchemaYaml,
  type SchemaIssue,
  schemaShape,
  serializeSchemaYaml,
} from './schema-model';
import type { SQLiteWorldServiceStore } from './service-store';

// ---------------------------------------------------------------------------
// WorldSchemaService: the ONLY writer of every schema.yaml and of the
// `schema_versions` rows (plan Global Constraints, single owners). Guarantees
// and what pins them, in `__tests__/`:
//   - schema.yaml is written through the injected compose-time
//     `Storage.writeAtomic` and nowhere else: schema-service.test.ts 'apply
//     writes schema.yaml only through the injected Storage.writeAtomic ...'.
//   - the change rules table (R12): schema-rules.test.ts 'R12 change rules
//     table'; a used type is never removed: 'remove of a used type is refused
//     with the count'.
//   - an invalid hand edit never replaces the last good version (R14):
//     schema-service.test.ts 'R14 invalid hand edit keeps the last good version'.
//   - rename and merge re-assert live facts under the new name with their
//     original dates: 'rename retires and re-asserts with the same valid_from'.
//
// LIMITATION (no enforcer): WorldGraphProvider has no way to retire or retype
// an ENTITY (`retire` takes attributes and edges only). A rename or merge of
// an entity type re-asserts each entity under the new type and moves its
// attributes and edges, but the old entity rows stay in the backend, orphaned
// under a type the schema no longer lists.
// ---------------------------------------------------------------------------

/** Shared world: `<dataDir>/worlds/<slug>/schema.yaml`. Private: `<dataDir>/worlds/.private/<pid>/schema.yaml`
 * (a dot cannot appear in a slug, so no shared world can collide with the private tree). */
export function worldSchemaPath(dataDir: string, world: WorldId): string {
  return world.startsWith('personality:')
    ? join(dataDir, 'worlds', '.private', worldSlug(world), 'schema.yaml')
    : join(dataDir, 'worlds', worldSlug(world), 'schema.yaml');
}

export interface LoadedSchema {
  schema: WorldSchema;
  /** 0 when the world has no schema yet. */
  version: number;
  errors: SchemaIssue[];
  changelog: ChangelogEntry[];
  sensitive: string[];
}

export type ChangeBy = { kind: 'user' | 'agent'; id: string };

export interface WorldSchemaServiceDeps {
  /** Compose-time Storage: the only way schema.yaml is written. */
  storage: Storage;
  dataDir: string;
  store: SQLiteWorldServiceStore;
  provider: (w: WorldId) => Promise<WorldGraphProvider>;
  now?: () => number;
}

/** A migration reads at most this many live facts of a kind; more refuses the change. */
const MIGRATE_LIMIT = 5000;
const HAND_EDIT = 'you (hand edit)';

const changeMetaZ = z.object({ op: z.string(), class: z.enum(['additive', 'rewrite']).optional() });

export class WorldSchemaService {
  private readonly deps: WorldSchemaServiceDeps;
  private readonly now: () => number;

  constructor(deps: WorldSchemaServiceDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  /**
   * Reads schema.yaml. A valid file that differs from the newest recorded
   * version is recorded as a new version `you (hand edit)`; an invalid file
   * leaves the newest valid version in force, records the errors and is never
   * overwritten. The backend is brought to the resulting version.
   */
  async load(world: WorldId): Promise<LoadedSchema> {
    const { store, storage, dataDir } = this.deps;
    const latest = store.latestSchemaVersion(world);
    const parsedLatest = latest ? parseSchemaYaml(latest.yaml) : null;
    const good = parsedLatest?.ok ? parsedLatest : null;
    const lastGood = (errors: SchemaIssue[]): LoadedSchema =>
      good
        ? {
            schema: { ...good.schema, version: latest?.version ?? good.schema.version },
            version: latest?.version ?? 0,
            errors,
            changelog: good.changelog,
            sensitive: good.sensitive,
          }
        : {
            schema: { version: 0, entities: {}, edges: {} },
            version: 0,
            errors,
            changelog: [],
            sensitive: [],
          };

    const text = await storage.read(worldSchemaPath(dataDir, world));
    if (text === null) return lastGood([]);

    const parsed = parseSchemaYaml(text);
    if (!parsed.ok) {
      this.deps.store.recordLoadErrors(world, parsed.errors);
      return lastGood(parsed.errors);
    }

    let version = latest?.version ?? 0;
    if (!latest || !good || schemaShape(parsed) !== schemaShape(good)) {
      version = Math.max(parsed.schema.version, (latest?.version ?? 0) + 1);
      store.insertSchemaVersion({
        world,
        version,
        yaml: text,
        changeJson: JSON.stringify({ op: 'hand_edit' }),
        by: HAND_EDIT,
      });
    }
    const schema = { ...parsed.schema, version };
    const provider = await this.deps.provider(world);
    const held = await provider.getSchema(world);
    if (held === null || held.version !== version) {
      const r = await provider.applySchema(world, schema);
      if (!r.ok) {
        return lastGood([{ line: 1, message: `backend refused the schema: ${r.reason}` }]);
      }
    }
    return {
      schema,
      version,
      errors: [],
      changelog: parsed.changelog,
      sensitive: parsed.sensitive,
    };
  }

  /**
   * The ONLY writer of schema.yaml: validate, migrate facts for a rewrite,
   * bump the version, add the changelog entry, `writeAtomic`, record the
   * `schema_versions` row, then `provider.applySchema`.
   */
  async apply(
    world: WorldId,
    change: SchemaChange,
    by: ChangeBy,
    reason: string,
  ): Promise<{ ok: true; version: number } | { ok: false; error: string }> {
    const cur = await this.load(world);
    const broken = this.brokenFile(cur);
    if (broken) return { ok: false, error: broken };

    if (change.op === 'remove_type') {
      const used = await this.usage(world, change.kind, change.type);
      if (used.count > 0) return { ok: false, error: usedMessage(change.kind, change.type, used) };
    }
    const next = applyChange(cur, change);
    if (!next.ok) return { ok: false, error: next.error };

    const version = cur.version + 1;
    const nextSchema: WorldSchema = { ...next.schema, version };
    if (classifySchemaChange(change) === 'rewrite' && change.op !== 'remove_type') {
      const failed = await this.migrate(world, change, cur.schema, nextSchema);
      if (failed) return { ok: false, error: failed };
    }

    return this.commit(world, {
      schema: nextSchema,
      sensitive: next.sensitive,
      previous: cur.changelog,
      by: by.kind === 'user' ? 'you' : 'agent',
      rowBy: by.kind === 'user' ? 'you' : `agent:${by.id}`,
      change: describeChange(change),
      reason,
      changeJson: JSON.stringify({ ...change, class: classifySchemaChange(change) }),
    });
  }

  /**
   * Routes an agent change through the rules table (R12): additive on a private
   * world applies now; everything else becomes a proposal for the owner, except
   * removing a type that live facts use, which is refused.
   */
  async requestChange(
    world: ResolvedWorld,
    change: SchemaChange,
    by: string,
    reason: string,
  ): Promise<{ applied: number } | { proposalId: string } | { refused: string }> {
    if (change.op === 'remove_type') {
      const used = await this.usage(world.id, change.kind, change.type);
      if (used.count > 0) return { refused: usedMessage(change.kind, change.type, used) };
    }
    if (classifySchemaChange(change) === 'additive' && !world.shared) {
      const r = await this.apply(world.id, change, { kind: 'agent', id: by }, reason);
      return r.ok ? { applied: r.version } : { refused: r.error };
    }
    const queued = this.deps.store.propose({
      world: world.id,
      kind: 'schema',
      payload: { change },
      summary: reason ? `${describeChange(change)}: ${reason}` : describeChange(change),
      sourceRef: 'schema:request',
      proposedBy: by,
    });
    if ('refused' in queued) {
      return { refused: `the owner already rejected this change (${describeChange(change)})` };
    }
    return { proposalId: queued.id };
  }

  /**
   * Restores the previous version's content as a new version and logs it.
   * Refused after a rename or merge (the facts were rewritten; apply the
   * inverse change) and when it would drop a type live facts use.
   */
  async undoLast(
    world: WorldId,
    by: string,
  ): Promise<{ ok: true; version: number } | { ok: false; error: string }> {
    const cur = await this.load(world);
    const broken = this.brokenFile(cur);
    if (broken) return { ok: false, error: broken };

    const [last, prev] = this.deps.store.listSchemaVersions(world);
    if (!last || !prev) return { ok: false, error: 'nothing to undo' };

    const meta = this.parseMeta(last.changeJson);
    if (meta?.class === 'rewrite' && meta.op !== 'remove_type') {
      return {
        ok: false,
        error: `v${last.version} rewrote facts (${meta.op}); apply the inverse change instead`,
      };
    }
    const before = parseSchemaYaml(prev.yaml);
    if (!before.ok) return { ok: false, error: `v${prev.version} is not a valid schema` };

    for (const type of Object.keys(cur.schema.entities)) {
      if (before.schema.entities[type]) continue;
      const used = await this.usage(world, 'entity', type);
      if (used.count > 0) return { ok: false, error: usedMessage('entity', type, used) };
    }
    for (const type of Object.keys(cur.schema.edges)) {
      if (before.schema.edges[type]) continue;
      const used = await this.usage(world, 'edge', type);
      if (used.count > 0) return { ok: false, error: usedMessage('edge', type, used) };
    }

    const version = cur.version + 1;
    return this.commit(world, {
      schema: { ...before.schema, version },
      sensitive: before.sensitive,
      previous: cur.changelog,
      by: 'you',
      rowBy: `you:${by}`,
      change: `undo v${last.version} (restore v${prev.version})`,
      reason: '',
      changeJson: JSON.stringify({ op: 'undo', class: 'additive', restores: prev.version }),
    });
  }

  // ---- internals ------------------------------------------------------------

  private brokenFile(cur: LoadedSchema): string | null {
    const first = cur.errors[0];
    return first
      ? `schema.yaml has errors (line ${first.line}: ${first.message}); fix the file first`
      : null;
  }

  private parseMeta(json: string): { op: string; class?: 'additive' | 'rewrite' } | null {
    try {
      const r = changeMetaZ.safeParse(JSON.parse(json));
      return r.success ? r.data : null;
    } catch {
      return null;
    }
  }

  private async commit(
    world: WorldId,
    o: {
      schema: WorldSchema;
      sensitive: string[];
      previous: ChangelogEntry[];
      by: string;
      rowBy: string;
      change: string;
      reason: string;
      changeJson: string;
    },
  ): Promise<{ ok: true; version: number } | { ok: false; error: string }> {
    const { storage, dataDir, store } = this.deps;
    const entry: ChangelogEntry = {
      v: o.schema.version,
      by: o.by,
      at: new Date(this.now()).toISOString().slice(0, 10),
      change: o.change,
      ...(o.reason ? { reason: o.reason } : {}),
    };
    const yaml = serializeSchemaYaml({
      schema: o.schema,
      sensitive: o.sensitive,
      changelog: [entry, ...o.previous],
    });
    const path = worldSchemaPath(dataDir, world);
    await storage.mkdir(dirname(path));
    await storage.writeAtomic(path, yaml);
    store.insertSchemaVersion({
      world,
      version: o.schema.version,
      yaml,
      changeJson: o.changeJson,
      by: o.rowBy,
      reason: o.reason || null,
    });
    const provider = await this.deps.provider(world);
    const applied = await provider.applySchema(world, o.schema);
    if (!applied.ok) return { ok: false, error: `backend refused the schema: ${applied.reason}` };
    return { ok: true, version: o.schema.version };
  }

  private async usage(
    world: WorldId,
    kind: 'entity' | 'edge',
    type: string,
  ): Promise<{ count: number; truncated: boolean }> {
    const provider = await this.deps.provider(world);
    if (kind === 'entity') {
      const r = await provider.query(world, {
        kind: 'entities',
        types: [type],
        limit: MIGRATE_LIMIT,
      });
      return { count: r.entities.length, truncated: r.truncated };
    }
    const r = await provider.query(world, { kind: 'edges', types: [type], limit: MIGRATE_LIMIT });
    return { count: r.edges.length, truncated: r.truncated };
  }

  /**
   * Rename and merge as close-and-reopen: every live fact of the old name is
   * re-asserted under the new one with its original dates, author and
   * confidence (source `schema:v<n>`), then retired. While it runs the backend
   * holds the union of old and new schema so both names are assertable; a
   * failure puts the old schema back. Returns an error message or null.
   */
  private async migrate(
    world: WorldId,
    change: SchemaChange,
    before: WorldSchema,
    after: WorldSchema,
  ): Promise<string | null> {
    const provider = await this.deps.provider(world);
    const src = `schema:v${after.version}`;
    const held = await provider.applySchema(world, unionSchema(before, after));
    if (!held.ok) return `backend refused the schema: ${held.reason}`;
    try {
      await this.moveFacts(provider, world, change, src);
      return null;
    } catch (err) {
      if (before.version >= 1) await provider.applySchema(world, before);
      return err instanceof Error ? err.message : String(err);
    }
  }

  private async moveFacts(
    provider: WorldGraphProvider,
    world: WorldId,
    change: SchemaChange,
    src: string,
  ): Promise<void> {
    const liveEdges = async (types?: string[]): Promise<Edge[]> => {
      const r = await provider.query(world, { kind: 'edges', types, limit: MIGRATE_LIMIT });
      if (r.truncated)
        throw new Error(`too many live edges to migrate in one change (over ${MIGRATE_LIMIT})`);
      return r.edges;
    };
    const liveEntities = async (type: string) => {
      const r = await provider.query(world, {
        kind: 'entities',
        types: [type],
        limit: MIGRATE_LIMIT,
      });
      if (r.truncated)
        throw new Error(`too many live entities to migrate in one change (over ${MIGRATE_LIMIT})`);
      return r;
    };
    const reopenEdge = async (e: Edge, over: Partial<FactInputEdge>): Promise<void> => {
      const input: FactInput = {
        kind: 'edge',
        type: e.type,
        fromId: e.fromId,
        toId: e.toId,
        attrs: e.attrs,
        ...(e.validFrom !== null ? { validFrom: e.validFrom } : {}),
        sourceRef: src,
        author: e.author,
        confidence: e.confidence,
        ...over,
      };
      await expectOk(provider.assert(world, [input]));
      await expectOk(provider.retire(world, e.id, src, e.author));
    };

    if (change.op === 'rename_type' && change.kind === 'edge') {
      for (const e of await liveEdges([change.from])) await reopenEdge(e, { type: change.to });
      return;
    }

    if (change.op === 'rename_attribute' && 'edge' in change.on) {
      for (const e of await liveEdges([change.on.edge])) {
        if (!(change.from in e.attrs)) continue;
        const { [change.from]: value, ...rest } = e.attrs;
        await reopenEdge(e, { attrs: { ...rest, [change.to]: value } });
      }
      return;
    }

    if (change.op === 'rename_attribute') {
      const found = await liveEntities((change.on as { entity: string }).entity);
      const moving = found.attributes.filter((a) => a.key === change.from);
      if (moving.length > 0) {
        await expectOk(
          provider.assert(
            world,
            moving.map((a) => ({
              kind: 'attribute' as const,
              entityId: a.entityId,
              key: change.to,
              value: a.value,
              ...(a.validFrom !== null ? { validFrom: a.validFrom } : {}),
              sourceRef: src,
              author: a.author,
              confidence: a.confidence,
            })),
          ),
        );
        for (const a of moving) await expectOk(provider.retire(world, a.id, src, a.author));
      }
      return;
    }

    if (change.op === 'rename_type' || change.op === 'merge_types') {
      const from = change.from;
      const to = change.op === 'rename_type' ? change.to : change.into;
      const found = await liveEntities(from);
      if (found.entities.length === 0) return;
      const made = await expectOk(
        provider.assert(
          world,
          found.entities.map((e) => ({
            kind: 'entity' as const,
            type: to,
            name: e.name,
            aliases: e.aliases,
            sourceRef: src,
            author: e.author,
          })),
        ),
      );
      const idMap = new Map(found.entities.map((e, i) => [e.id, made[i] as string]));
      if (found.attributes.length > 0) {
        await expectOk(
          provider.assert(
            world,
            found.attributes.map((a) => ({
              kind: 'attribute' as const,
              entityId: idMap.get(a.entityId) as string,
              key: a.key,
              value: a.value,
              ...(a.validFrom !== null ? { validFrom: a.validFrom } : {}),
              sourceRef: src,
              author: a.author,
              confidence: a.confidence,
            })),
          ),
        );
        for (const a of found.attributes)
          await expectOk(provider.retire(world, a.id, src, a.author));
      }
      for (const e of await liveEdges()) {
        if (!idMap.has(e.fromId) && !idMap.has(e.toId)) continue;
        await reopenEdge(e, {
          fromId: idMap.get(e.fromId) ?? e.fromId,
          toId: idMap.get(e.toId) ?? e.toId,
        });
      }
    }
  }
}

type FactInputEdge = Extract<FactInput, { kind: 'edge' }>;

async function expectOk(
  p: Promise<{ ok: true; ids: string[] } | { ok: false; code: string; reason: string }>,
): Promise<string[]> {
  const r = await p;
  if (!r.ok) throw new Error(`backend refused a migrated fact: ${r.reason}`);
  return r.ids;
}

function usedMessage(
  kind: 'entity' | 'edge',
  type: string,
  used: { count: number; truncated: boolean },
): string {
  return `${kind} type '${type}' is used by ${used.count}${used.truncated ? '+' : ''} live facts; retire them first`;
}
