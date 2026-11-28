import { EthosError, type FactInput, type WorldId } from '@ethosagent/types';
import { MAX_SNAPSHOT_BYTES, worldOwner } from '@ethosagent/wiring';
import type { ActorReader } from '../features/share/actor';

const {
  buildWorldSnapshot,
  bundleFromText,
  describeBuildItem,
  exportCsv,
  exportFactsYaml,
  exportMcpJsonl,
  parseWorldId,
  resolveAccess,
  sliceBundle,
  toBundleJson,
  toGraphML,
  toMermaid,
  WorldConfigError,
  WorldServiceError,
  worldSlug,
} = worldOwner;
type AccessResult = worldOwner.AccessResult;
type MountsFile = worldOwner.MountsFile;
type WorldConfigService = worldOwner.WorldConfigService;
type WorldFile = worldOwner.WorldFile;
type WorldSchemaService = worldOwner.WorldSchemaService;
type WorldService = worldOwner.WorldService;

// The owner's door onto the world model (plan world-model 7.2). The operator owns every
// personality, so every world is visible here, private ones included; the signed-in owner
// (`ActorReader`, `web:<admin>`) is `decided_by` on every decision and author `user` on every
// write. Nothing here holds a graph backend: reads and writes go through WorldService,
// WorldSchemaService (schema.yaml) and WorldConfigService (world.yaml, worlds.yaml), the single
// owners (plan Global Constraints).
//
// Cookie-only: `worlds` is deliberately absent from SCOPE_MAP (middleware/dual-auth.ts), so a
// bearer key is refused 403 ('bearer key is refused'), and the CSRF middleware covers every
// cookie-authenticated POST ('missing CSRF is refused'); both in
// __tests__/routes/worlds-rpc.test.ts.
//
// LIMITATIONS (no enforcer, stated):
//   - `list` counts entities and live edges from `ownerExport`, so its cost grows with each world.
//   - `reason` on `schemaSave` is not recorded: WorldSchemaService.saveYaml writes every whole-file
//     edit as `you (hand edit)`.
//   - `isNew` means "recorded in the last 7 days"; the wire contract does not define it.

/** What the wiring-composed world runtime hands this service (`WorldRuntime` in @ethosagent/wiring). */
export interface WorldsRuntime {
  service: WorldService;
  schema: WorldSchemaService;
  configService: WorldConfigService;
}

export interface WorldsServiceDeps {
  /** Absent when `world.enabled` is false: every procedure answers NOT_CONFIGURED. */
  runtime: WorldsRuntime | undefined;
  actor: ActorReader;
  /** Every personality the operator owns. */
  personalityIds: () => Promise<string[]>;
  /** A personality's memory notes (`MEMORY.md`, `USER.md`); empty when the backend has no editor. */
  memoryNotes: (personalityId: string) => Promise<Array<{ scope: string; text: string }>>;
  /** Stores one world snapshot as a share link (ShareService.publishWorld). */
  publishWorld: (input: {
    world: string;
    title: string;
    snapshot: string;
    expiresInDays: number;
  }) => Promise<
    | { ok: true; url: string; id: string; expiresAt: string }
    | { ok: false; reason: 'disabled' }
    | { ok: false; reason: 'too_large'; limitBytes: number }
  >;
  now?: () => number;
}

export type WorldsErrorKind = 'not_found' | 'conflict' | 'invalid';

/** Mapped to NOT_FOUND 404 / CONFLICT 409 / INPUT_INVALID 400 by rpc/worlds.ts. */
export class WorldsApiError extends Error {
  readonly kind: WorldsErrorKind;
  constructor(kind: WorldsErrorKind, message: string) {
    super(message);
    this.name = 'WorldsApiError';
    this.kind = kind;
  }
}

const NEW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_GRAPH_LIMIT = 300;
const TREE_LIMIT = 2000;
const CHANGES_LIMIT = 500;
const MENTION_LIMIT = 20;
const EXCERPT_RADIUS = 60;
const NOTE_NOT_PROPOSER = 'not in proposers';

type Mode = 'read' | 'propose';
interface Effective {
  effective: Mode;
  note?: string;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isLiveFact = (
  f: { validTo: string | null; retiredAt: string | null },
  now: string,
): boolean => f.retiredAt === null && (f.validTo === null || f.validTo > now);
const atAsOf = (f: { validFrom: string | null; validTo: string | null }, asOf: string): boolean =>
  (f.validFrom === null || f.validFrom <= asOf) && (f.validTo === null || f.validTo > asOf);

export class WorldsService {
  constructor(private readonly deps: WorldsServiceDeps) {}

  private rt(): WorldsRuntime {
    if (!this.deps.runtime) {
      throw new EthosError({
        code: 'NOT_CONFIGURED',
        cause: 'The world model is not enabled on this server',
        action: 'Set world.enabled: true in config.yaml and restart.',
      });
    }
    return this.deps.runtime;
  }

  private nowMs(): number {
    return (this.deps.now ?? Date.now)();
  }

  private nowIso(): string {
    return new Date(this.nowMs()).toISOString();
  }

  /** The wire id as a real world: a shared world needs a world.yaml, a private one a personality. */
  private async known(id: string): Promise<WorldId> {
    const rt = this.rt();
    let world: WorldId;
    try {
      world = parseWorldId(id);
    } catch (e) {
      throw new WorldsApiError('invalid', e instanceof Error ? e.message : String(e));
    }
    if (world.startsWith('personality:')) {
      if (!(await this.deps.personalityIds()).includes(worldSlug(world))) {
        throw new WorldsApiError('not_found', `${id} does not exist`);
      }
    } else if ((await rt.configService.readWorld(worldSlug(world))) === null) {
      throw new WorldsApiError('not_found', `${id} does not exist`);
    }
    return world;
  }

  // ---- list ----------------------------------------------------------------

  async list() {
    const rt = this.rt();
    const [worlds, pids] = await Promise.all([
      rt.configService.listWorlds(),
      this.deps.personalityIds(),
    ]);
    const mountsOf = await this.allMounts(pids);
    const out = [];
    for (const w of worlds.values()) {
      out.push(
        await this.summary(
          `world:${w.id}` as WorldId,
          w.title,
          w.audience,
          w.backend,
          worlds,
          mountsOf,
        ),
      );
    }
    for (const pid of pids) {
      out.push(
        await this.summary(
          `personality:${pid}` as WorldId,
          `${pid} (private)`,
          'owner_only',
          'sqlite',
          worlds,
          mountsOf,
        ),
      );
    }
    return { worlds: out };
  }

  private async allMounts(pids: string[]): Promise<Map<string, MountsFile>> {
    const rt = this.rt();
    const out = new Map<string, MountsFile>();
    for (const pid of pids) out.set(pid, await rt.configService.readMounts(pid));
    return out;
  }

  private async summary(
    id: WorldId,
    title: string,
    audience: 'owner_only' | 'shareable',
    backend: string,
    worlds: ReadonlyMap<string, WorldFile>,
    mountsOf: Map<string, MountsFile>,
  ) {
    const rt = this.rt();
    const bundle = await rt.service.ownerExport(id);
    const mountedBy = mountedOf(id, worlds, mountsOf);
    return {
      id,
      title,
      audience,
      backend,
      counts: {
        entities: bundle.entities.filter((e) => e.retiredAt === null && e.mergedInto === null)
          .length,
        liveEdges: bundle.edges.filter((e) => e.validTo === null && e.retiredAt === null).length,
        pendingProposals: rt.service.ownerPendingCount(id),
      },
      mountedBy,
    };
  }

  // ---- graph, tree, entity, changes -------------------------------------------

  async graph(input: {
    world: string;
    asOf?: string | undefined;
    focus?: string | undefined;
    hops?: number | undefined;
    types?: string[] | undefined;
    limit?: number | undefined;
  }) {
    const world = await this.known(input.world);
    const svc = this.rt().service;
    const slice = input.asOf === undefined ? undefined : { asOf: input.asOf };
    const limit = input.limit ?? DEFAULT_GRAPH_LIMIT;
    const typeOk = (t: string): boolean =>
      !input.types || input.types.length === 0 || input.types.includes(t);
    const newSince = new Date(this.nowMs() - NEW_DAYS * DAY_MS).toISOString();

    let entities: Array<{ id: string; type: string; name: string; recordedAt: string }>;
    let edges: Array<{
      id: string;
      type: string;
      fromId: string;
      toId: string;
      validFrom: string | null;
      validTo: string | null;
      author: 'user' | 'import' | 'connector' | 'agent';
    }>;
    let truncated: boolean;
    if (input.focus !== undefined) {
      const sub = await svc.ownerNeighbours(world, input.focus, input.hops ?? 1, slice);
      if (!sub.entities.some((e) => e.id === input.focus)) {
        throw new WorldsApiError('not_found', `${input.world} has no entity ${input.focus}`);
      }
      entities = sub.entities;
      edges = sub.edges;
      truncated = sub.truncated;
    } else {
      const ents = await svc.ownerQuery(
        world,
        {
          kind: 'entities',
          ...(input.types && input.types.length > 0 ? { types: input.types } : {}),
          limit,
        },
        slice,
      );
      const eds = await svc.ownerQuery(
        world,
        { kind: 'edges', limit: Math.min(limit * 4, 10_000) },
        slice,
      );
      entities = ents.entities;
      edges = eds.edges;
      truncated = ents.truncated || eds.truncated;
    }
    const nodes = entities.filter((e) => typeOk(e.type));
    const ids = new Set(nodes.map((n) => n.id));
    return {
      nodes: nodes.map((e) => ({
        id: e.id,
        type: e.type,
        name: e.name,
        isNew: e.recordedAt >= newSince,
      })),
      edges: edges
        .filter((e) => ids.has(e.fromId) && ids.has(e.toId))
        .map((e) => ({
          id: e.id,
          type: e.type,
          from: e.fromId,
          to: e.toId,
          validFrom: e.validFrom,
          validTo: e.validTo,
          author: e.author,
        })),
      truncated,
    };
  }

  async tree(input: { world: string; asOf?: string | undefined }) {
    const world = await this.known(input.world);
    const svc = this.rt().service;
    const slice = input.asOf === undefined ? undefined : { asOf: input.asOf };
    const ents = await svc.ownerQuery(world, { kind: 'entities', limit: TREE_LIMIT }, slice);
    const eds = await svc.ownerQuery(world, { kind: 'edges', limit: TREE_LIMIT * 4 }, slice);
    const degree = new Map<string, number>();
    for (const e of eds.edges) {
      degree.set(e.fromId, (degree.get(e.fromId) ?? 0) + 1);
      degree.set(e.toId, (degree.get(e.toId) ?? 0) + 1);
    }
    const newSince = new Date(this.nowMs() - NEW_DAYS * DAY_MS).toISOString();
    const byType = new Map<
      string,
      Array<{ id: string; name: string; edgeCount: number; isNew: boolean }>
    >();
    for (const e of ents.entities) {
      const list = byType.get(e.type) ?? [];
      list.push({
        id: e.id,
        name: e.name,
        edgeCount: degree.get(e.id) ?? 0,
        isNew: e.recordedAt >= newSince,
      });
      byType.set(e.type, list);
    }
    return {
      groups: [...byType]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([type, entities]) => ({
          type,
          entities: entities.sort(
            (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
          ),
        })),
    };
  }

  async entity(input: { world: string; entityId: string; asOf?: string | undefined }) {
    const world = await this.known(input.world);
    const svc = this.rt().service;
    const slice = input.asOf === undefined ? undefined : { asOf: input.asOf };
    const sub = await svc.ownerNeighbours(world, input.entityId, 1, slice);
    const centre = sub.entities.find((e) => e.id === input.entityId);
    if (!centre)
      throw new WorldsApiError('not_found', `${input.world} has no entity ${input.entityId}`);
    const names = new Map(sub.entities.map((e) => [e.id, e.name]));
    const hist = await svc.ownerHistory(world, input.entityId);
    const now = this.nowIso();
    const when = (f: { validFrom: string | null; validTo: string | null }): boolean =>
      input.asOf === undefined || atAsOf(f, input.asOf);
    const facts = hist.attributes
      .filter((a) => a.retiredAt === null && when(a))
      .map((a) => ({
        id: a.id,
        key: a.key,
        value: a.value,
        validFrom: a.validFrom,
        validTo: a.validTo,
        recordedAt: a.recordedAt,
        author: a.author,
        sourceRef: a.sourceRef,
        confidence: a.confidence,
        promotable: isLiveFact(a, now) && a.author !== 'user' && a.author !== 'import',
      }));
    const edges = hist.edges
      .filter((e) => e.retiredAt === null && when(e))
      .map((e) => {
        const out = e.fromId === input.entityId;
        const otherId = out ? e.toId : e.fromId;
        return {
          id: e.id,
          type: e.type,
          direction: out ? ('out' as const) : ('in' as const),
          otherId,
          otherName: names.get(otherId) ?? otherId,
          validFrom: e.validFrom,
          validTo: e.validTo,
          author: e.author,
        };
      });
    const mountedBy = await this.mountedByWorld(world);
    const memoryMentions = await this.mentions(
      [centre.name, ...centre.aliases],
      [
        ...new Set([
          ...mountedBy.map((m) => m.personalityId),
          ...(world.startsWith('personality:') ? [worldSlug(world)] : []),
        ]),
      ],
    );
    return {
      id: centre.id,
      world: input.world,
      type: centre.type,
      name: centre.name,
      aliases: centre.aliases,
      retiredAt: centre.retiredAt,
      facts,
      edges,
      memoryMentions,
      mountedBy,
    };
  }

  private async mountedByWorld(world: WorldId) {
    if (!world.startsWith('world:')) return [];
    const [worlds, pids] = await Promise.all([
      this.rt().configService.listWorlds(),
      this.deps.personalityIds(),
    ]);
    return mountedOf(world, worlds, await this.allMounts(pids));
  }

  private async mentions(needles: string[], personalityIds: string[]) {
    const wanted = needles.map((n) => n.toLowerCase()).filter((n) => n.length >= 2);
    const out: Array<{ scope: string; excerpt: string }> = [];
    for (const pid of personalityIds) {
      for (const note of await this.deps.memoryNotes(pid)) {
        const lower = note.text.toLowerCase();
        for (const n of wanted) {
          const at = lower.indexOf(n);
          if (at < 0) continue;
          const from = Math.max(0, at - EXCERPT_RADIUS);
          out.push({
            scope: note.scope,
            excerpt: note.text
              .slice(from, Math.min(note.text.length, at + n.length + EXCERPT_RADIUS))
              .trim(),
          });
          break;
        }
        if (out.length >= MENTION_LIMIT) return out;
      }
    }
    return out;
  }

  async changes(input: { world: string; since: string; limit?: number | undefined }) {
    const world = await this.known(input.world);
    const svc = this.rt().service;
    const rows = await svc.ownerChanges(world, input.since, input.limit ?? CHANGES_LIMIT);
    const bundle = await svc.ownerExport(world);
    const name = new Map(bundle.entities.map((e) => [e.id, e.name]));
    const text = new Map<string, string>();
    for (const e of bundle.entities) text.set(e.id, `${e.type} ${e.name}`);
    for (const a of bundle.attributes)
      text.set(a.id, `${name.get(a.entityId) ?? a.entityId}.${a.key} = ${JSON.stringify(a.value)}`);
    for (const e of bundle.edges) {
      text.set(
        e.id,
        `${name.get(e.fromId) ?? e.fromId} -${e.type}-> ${name.get(e.toId) ?? e.toId}`,
      );
    }
    type Author = (typeof rows)[number]['author'];
    const groups = new Map<
      string,
      {
        sourceRef: string;
        author: Author;
        changes: Array<{
          at: string;
          kind: (typeof rows)[number]['kind'];
          factId: string;
          summary: string;
          author: Author;
        }>;
      }
    >();
    for (const r of rows) {
      const key = `${r.sourceRef}\u0000${r.author}`;
      const g = groups.get(key) ?? { sourceRef: r.sourceRef, author: r.author, changes: [] };
      g.changes.push({
        at: r.at,
        kind: r.kind,
        factId: r.factId,
        summary: text.get(r.factId) ?? r.factId,
        author: r.author,
      });
      groups.set(key, g);
    }
    return { groups: [...groups.values()] };
  }

  // ---- proposals --------------------------------------------------------------

  async proposals(input: {
    world?: string | undefined;
    status?: 'pending' | 'accepted' | 'rejected' | 'superseded' | 'expired' | undefined;
  }) {
    const rt = this.rt();
    const world = input.world === undefined ? undefined : await this.known(input.world);
    const rows = rt.service.ownerProposals({
      ...(world ? { world } : {}),
      ...(input.status ? { status: input.status } : {}),
    });
    return {
      proposals: rows.map((r) => ({
        id: r.id,
        world: r.world,
        kind: r.kind,
        status: r.status,
        summary: r.summary,
        conflictWith: r.conflictWith,
        sourceRef: r.sourceRef,
        proposedBy: r.proposedBy,
        confidence: r.confidence,
        createdAt: r.createdAt,
        decidedAt: r.decidedAt,
        decidedBy: r.decidedBy,
        reason: r.reason,
      })),
    };
  }

  async decide(input: {
    proposalId: string;
    verdict: 'accept' | 'reject';
    reason?: string | undefined;
  }) {
    const svc = this.rt().service;
    const by = await this.deps.actor();
    const row = svc.ownerProposal(input.proposalId);
    if (!row) throw new WorldsApiError('not_found', `no proposal ${input.proposalId}`);
    if (row.status !== 'pending') {
      throw new WorldsApiError('conflict', `${input.proposalId} is already ${row.status}`);
    }
    if (input.verdict === 'reject') {
      try {
        await svc.rejectProposal(input.proposalId, by, input.reason);
      } catch (e) {
        if (e instanceof WorldServiceError && e.code === 'not_pending') {
          throw new WorldsApiError('conflict', `${input.proposalId} is no longer pending`);
        }
        throw e;
      }
      return { ok: true as const, applied: [], closed: [] };
    }
    const out = await svc.acceptProposal(input.proposalId, by);
    const failed = out.refused[0];
    if (failed && out.applied.length === 0) {
      throw new WorldsApiError(
        failed.reason.startsWith('not_pending') ? 'conflict' : 'invalid',
        failed.reason,
      );
    }
    return { ok: true as const, applied: out.applied, closed: out.closed ?? [] };
  }

  // ---- owner fact writes ------------------------------------------------------

  async factWrite(input: {
    world: string;
    fact:
      | { kind: 'entity'; type: string; name: string; aliases?: string[] | undefined }
      | {
          kind: 'attribute';
          entityId: string;
          key: string;
          value: unknown;
          validFrom?: string | undefined;
        }
      | {
          kind: 'edge';
          type: string;
          fromId: string;
          toId: string;
          attrs?: Record<string, unknown> | undefined;
          validFrom?: string | undefined;
        };
  }) {
    const world = await this.known(input.world);
    const by = await this.deps.actor();
    const common = { sourceRef: by, author: 'user' as const };
    const f = input.fact;
    const fact: FactInput =
      f.kind === 'entity'
        ? {
            kind: 'entity',
            type: f.type,
            name: f.name,
            ...(f.aliases ? { aliases: f.aliases } : {}),
            ...common,
          }
        : f.kind === 'attribute'
          ? {
              kind: 'attribute',
              entityId: f.entityId,
              key: f.key,
              value: f.value,
              ...(f.validFrom ? { validFrom: f.validFrom } : {}),
              confidence: 1,
              ...common,
            }
          : {
              kind: 'edge',
              type: f.type,
              fromId: f.fromId,
              toId: f.toId,
              ...(f.attrs ? { attrs: f.attrs } : {}),
              ...(f.validFrom ? { validFrom: f.validFrom } : {}),
              confidence: 1,
              ...common,
            };
    const out = await this.rt().service.ownerWrite(world, [fact], by);
    const refused = out.refused[0];
    if (refused)
      throw new WorldsApiError(
        refused.reason.startsWith('not_found') ? 'not_found' : 'invalid',
        refused.reason,
      );
    return { ok: true as const, ids: out.applied };
  }

  async factClose(input: { world: string; factId: string; validTo?: string | undefined }) {
    const world = await this.known(input.world);
    const by = await this.deps.actor();
    const out = await this.rt().service.ownerClose(
      world,
      input.factId,
      input.validTo ?? this.nowIso().slice(0, 10),
      by,
    );
    const refused = out.refused[0];
    if (refused) throw refusal(refused.reason);
    return { ok: true as const };
  }

  async promote(input: { world: string; factId: string }) {
    const world = await this.known(input.world);
    const by = await this.deps.actor();
    const out = await this.rt().service.promoteToUser(world, input.factId, by);
    const refused = out.refused[0];
    if (refused) throw refusal(refused.reason);
    const id = out.applied[0];
    if (id === undefined) throw new WorldsApiError('invalid', 'promotion produced no fact');
    return { ok: true as const, factId: id };
  }

  // ---- schema -----------------------------------------------------------------

  async schema(input: { world: string }) {
    const world = await this.known(input.world);
    const schema = this.rt().schema;
    const loaded = await schema.load(world);
    return {
      version: loaded.version,
      yaml: (await schema.readYaml(world)) ?? '',
      parsed: loaded.errors.length > 0 ? null : loaded.schema,
      sensitive: loaded.sensitive,
      changelog: loaded.changelog,
      versions: schema.versions(world),
      loadErrors: loaded.errors,
    };
  }

  async schemaSave(input: {
    world: string;
    yaml: string;
    expectedVersion: number;
    reason?: string | undefined;
  }) {
    const world = await this.known(input.world);
    const r = await this.rt().schema.saveYaml(world, input.yaml, input.expectedVersion);
    if (r.ok) return { ok: true as const, version: r.version };
    throw new WorldsApiError(r.kind === 'conflict' ? 'conflict' : 'invalid', r.error);
  }

  // ---- config (world.yaml) ----------------------------------------------------

  private async worldFile(id: string): Promise<WorldFile> {
    const world = await this.known(id);
    if (!world.startsWith('world:')) {
      throw new WorldsApiError('not_found', `${id} is private and has no world.yaml`);
    }
    const file = await this.rt().configService.readWorld(worldSlug(world));
    if (!file) throw new WorldsApiError('not_found', `${id} does not exist`);
    return file;
  }

  async config(input: { world: string }) {
    const f = await this.worldFile(input.world);
    return {
      id: f.id,
      backend: f.backend,
      title: f.title,
      audience: f.audience,
      readers: f.readers,
      proposers: f.proposers,
    };
  }

  async configSave(input: {
    world: string;
    title: string;
    audience: 'owner_only' | 'shareable';
    readers: string[];
    proposers: string[];
  }) {
    const current = await this.worldFile(input.world);
    const by = await this.deps.actor();
    try {
      await this.rt().configService.writeWorld(
        {
          id: current.id,
          backend: current.backend,
          title: input.title,
          audience: input.audience,
          readers: input.readers,
          proposers: input.proposers,
        },
        { by },
      );
    } catch (e) {
      if (e instanceof WorldConfigError) throw new WorldsApiError('invalid', e.message);
      throw e;
    }
    return { ok: true as const };
  }

  // ---- mounts (worlds.yaml) ---------------------------------------------------

  private async effectiveMounts(pid: string, mounts: MountsFile) {
    const worlds = await this.rt().configService.listWorlds();
    return mounts.mounts.map((m) => ({ world: m.world, ...effectiveOf(pid, m, worlds) }));
  }

  private async personality(pid: string): Promise<string> {
    if (!(await this.deps.personalityIds()).includes(pid)) {
      throw new WorldsApiError('not_found', `no personality ${pid}`);
    }
    return pid;
  }

  async mounts(input: { personalityId: string }) {
    const pid = await this.personality(input.personalityId);
    const mounts = await this.rt().configService.readMounts(pid);
    return {
      mounts: mounts.mounts.map(wireMount),
      effective: await this.effectiveMounts(pid, mounts),
    };
  }

  async mountsSave(input: {
    personalityId: string;
    mounts: Array<{ world: string; mode: Mode; as?: string | undefined }>;
  }) {
    const pid = await this.personality(input.personalityId);
    const by = await this.deps.actor();
    let saved: MountsFile;
    try {
      saved = await this.rt().configService.writeMounts(pid, { mounts: input.mounts }, { by });
    } catch (e) {
      if (e instanceof WorldConfigError) throw new WorldsApiError('invalid', e.message);
      throw e;
    }
    return { ok: true as const, effective: await this.effectiveMounts(pid, saved) };
  }

  // ---- export / import / build preview ----------------------------------------

  async export(input: {
    world: string;
    format: 'facts-yaml' | 'json' | 'graphml' | 'mermaid' | 'mcp-jsonl' | 'csv';
    asOf?: string | undefined;
  }) {
    const world = await this.known(input.world);
    const whole = await this.rt().service.ownerExport(world);
    const bundle = input.asOf === undefined ? whole : sliceBundle(whole, { asOf: input.asOf });
    const slug = worldSlug(world);
    switch (input.format) {
      case 'facts-yaml':
        return {
          filename: `${slug}.facts.yaml`,
          mime: 'application/yaml',
          text: exportFactsYaml(bundle),
        };
      case 'json':
        return { filename: `${slug}.json`, mime: 'application/json', text: toBundleJson(bundle) };
      case 'graphml':
        return {
          filename: `${slug}.graphml`,
          mime: 'application/graphml+xml',
          text: toGraphML(bundle),
        };
      case 'mermaid':
        return { filename: `${slug}.mmd`, mime: 'text/plain', text: toMermaid(bundle) };
      case 'mcp-jsonl':
        return {
          filename: `${slug}.jsonl`,
          mime: 'application/x-ndjson',
          text: exportMcpJsonl(bundle),
        };
      case 'csv': {
        const { entitiesCsv, linksCsv } = exportCsv(bundle);
        return {
          filename: `${slug}.csv`,
          mime: 'text/csv',
          text: `# entities.csv\n${entitiesCsv}\n# links.csv\n${linksCsv}`,
        };
      }
    }
  }

  async import(input: {
    world: string;
    format: 'facts-yaml' | 'json' | 'mcp-jsonl' | 'csv';
    text: string;
  }) {
    const world = await this.known(input.world);
    const rt = this.rt();
    const by = await this.deps.actor();
    const now = this.nowIso();
    const schema = (await rt.schema.load(world)).schema;
    const parsed = bundleFromText(input.format, input.text, { world, schema, by, now });
    if (!parsed.ok) throw new WorldsApiError('invalid', parsed.error);
    const { bundle, skipped } = parsed;
    const out = await rt.service.ownerImport(world, bundle, by);
    return {
      entities: out.report.entities,
      attributes: out.report.attributes,
      edges: out.report.edges,
      skipped: [...out.report.skipped, ...skipped],
    };
  }

  /** `source` is the id of a staged first build (`world_build` run); its items are read from service.db. */
  async buildPreview(input: { world: string; source: string }) {
    const world = await this.known(input.world);
    const found = this.rt().service.ownerBuild(input.source);
    if (!found || found.build.world !== world) {
      throw new WorldsApiError('not_found', `${input.world} has no staged build ${input.source}`);
    }
    const items = found.items.flatMap((i) => {
      const d = describeBuildItem(i);
      return d ? [d] : [];
    });
    const count = (k: 'entity' | 'attribute' | 'edge'): number =>
      items.filter((i) => i.kind === k).length;
    const conflicts = items.filter((i) => i.conflict).length;
    return {
      summary: {
        entities: count('entity'),
        attributes: count('attribute'),
        edges: count('edge'),
        proposals: world.startsWith('world:') ? items.length : conflicts,
      },
      items,
    };
  }

  // ---- share ------------------------------------------------------------------

  /**
   * A frozen, redacted, read-only copy of one world view behind an unguessable link (plan 7.6).
   * Sensitive attributes, email and location never leave unless the owner unticks the last two;
   * the builder is extensions/world-service/src/share-snapshot.ts (pinned by world-snapshot.test.ts).
   * Sharing off is NOT_CONFIGURED (shareLinks.enabled); an oversize view is data (`too_large`).
   * Pinned by __tests__/routes/worlds-rpc.test.ts 'shareCreate stores a world link'.
   */
  async shareCreate(input: {
    world: string;
    view: 'tree' | 'graph';
    asOf?: string | undefined;
    expiresInDays: number;
    keepEmail?: boolean | undefined;
    keepLocation?: boolean | undefined;
  }) {
    const world = await this.known(input.world);
    const rt = this.rt();
    const createdAt = this.nowIso();
    const asOf = input.asOf ?? createdAt;
    const slug = worldSlug(world);
    const title = world.startsWith('world:')
      ? ((await rt.configService.readWorld(slug))?.title ?? slug)
      : `${slug} (private)`;
    const [bundle, loaded] = await Promise.all([
      rt.service.ownerExport(world),
      rt.schema.load(world),
    ]);
    const built = buildWorldSnapshot(bundle, {
      world,
      title,
      view: input.view,
      asOf,
      createdAt,
      sensitive: loaded.sensitive,
      ...(input.keepEmail ? { keepEmail: true } : {}),
      ...(input.keepLocation ? { keepLocation: true } : {}),
      maxBytes: MAX_SNAPSHOT_BYTES,
    });
    if (!built.ok)
      return { ok: false as const, reason: built.reason, limitBytes: built.limitBytes };
    const stored = await this.deps.publishWorld({
      world,
      title: built.snapshot.title,
      snapshot: JSON.stringify(built.snapshot),
      expiresInDays: input.expiresInDays,
    });
    if (!stored.ok && stored.reason === 'disabled') {
      throw new EthosError({
        code: 'NOT_CONFIGURED',
        cause: 'Share links are turned off',
        action: 'Set shareLinks.enabled: true in config.yaml and restart.',
      });
    }
    if (!stored.ok) return stored;
    return {
      ok: true as const,
      url: stored.url,
      id: stored.id,
      expiresAt: stored.expiresAt,
      redacted: built.snapshot.redacted,
    };
  }

  // ---- linkify ----------------------------------------------------------------

  async linkify(input: { world: string; text: string }) {
    const world = await this.known(input.world);
    const ents = await this.rt().service.ownerQuery(world, { kind: 'entities', limit: TREE_LIMIT });
    const byKey = new Map<string, { id: string; type: string }>();
    for (const e of ents.entities) {
      for (const n of [e.name, ...e.aliases]) {
        const k = n.trim().toLowerCase();
        if (k.length >= 2 && !byKey.has(k)) byKey.set(k, { id: e.id, type: e.type });
      }
    }
    if (byKey.size === 0 || input.text === '') return { spans: [{ text: input.text }] };
    const alternation = [...byKey.keys()]
      .sort((a, b) => b.length - a.length)
      .map(escapeRe)
      .join('|');
    const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternation})(?![\\p{L}\\p{N}])`, 'giu');
    const spans: Array<{ text: string; entity?: { id: string; type: string } }> = [];
    let last = 0;
    for (const m of input.text.matchAll(re)) {
      const entity = byKey.get(m[0].toLowerCase());
      if (!entity || m.index === undefined) continue;
      if (m.index > last) spans.push({ text: input.text.slice(last, m.index) });
      spans.push({ text: m[0], entity });
      last = m.index + m[0].length;
    }
    if (last < input.text.length) spans.push({ text: input.text.slice(last) });
    return { spans };
  }
}

/** The personalities that mount a shared world (a private world has none). */
function mountedOf(
  id: WorldId,
  worlds: ReadonlyMap<string, WorldFile>,
  mountsOf: ReadonlyMap<string, MountsFile>,
): Array<{ personalityId: string; mode: Mode } & Effective> {
  const out: Array<{ personalityId: string; mode: Mode } & Effective> = [];
  if (!id.startsWith('world:')) return out;
  for (const [pid, mounts] of mountsOf) {
    for (const m of mounts.mounts) {
      if (m.world === worldSlug(id))
        out.push({ personalityId: pid, mode: m.mode, ...effectiveOf(pid, m, worlds) });
    }
  }
  return out;
}

function wireMount(m: { world: string; mode: Mode; as?: string | undefined }) {
  return { world: m.world, mode: m.mode, ...(m.as ? { as: m.as } : {}) };
}

/** A mount's effective mode via `resolveAccess` (the one access function), for the owner's view. */
function effectiveOf(
  personalityId: string,
  mount: { world: string; mode: Mode; as?: string | undefined },
  worlds: ReadonlyMap<string, WorldFile>,
): Effective {
  const r: AccessResult = resolveAccess({
    personalityId,
    audience: 'private',
    mounts: { mounts: [wireMount(mount)] },
    worlds,
  });
  const seen = r.visible.find((v) => v.shared);
  if (seen) {
    const effective = seen.mode === 'propose' ? 'propose' : 'read';
    return effective === mount.mode ? { effective } : { effective, note: NOTE_NOT_PROPOSER };
  }
  const inert = r.inert[0];
  const why = inert?.reason === 'unknown_world' ? 'no such world' : 'not in readers or proposers';
  return { effective: 'read', note: `inert: ${why}` };
}

function refusal(reason: string): WorldsApiError {
  if (reason.startsWith('not_found')) return new WorldsApiError('not_found', reason);
  if (reason.startsWith('closed') || reason.startsWith('already_authoritative')) {
    return new WorldsApiError('conflict', reason);
  }
  return new WorldsApiError('invalid', reason);
}
