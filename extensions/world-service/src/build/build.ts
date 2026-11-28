// WorldBuildService: the staged first build (plan world-model Tasks 5.2, 5.3).
//
// estimate -> run -> save. `run` extracts, merges and compares with live facts
// and STAGES everything in service.db (`builds`, `build_items`); no backend is
// touched until `save`, which hands the staged facts to
// `WorldService.importBundle`, so every routing rule stays in one place:
//   - a shared world gets ONE proposal batch and nothing live (R1):
//     tools-world world-build.test.ts 'save on a shared world creates one
//     batch, writes nothing live'.
//   - a user or import fact is never closed or overwritten; a contradiction
//     becomes a conflict proposal (R2, WorldService.place):
//     'a contradiction of a user fact is a conflict item' (staging) and
//     'a re-run reads only what is new and never touches user facts' (save).
//   - only a private-audience caller may build, and only for its own
//     personality: `assertOwn` below, 'a build of another personality is
//     refused' in build.test.ts.
//   - spend stops at estimate x 1.2 and keeps what was staged as `failed`:
//     'budget: build stops at the estimate x 1.2 and stages what it has as
//     failed-partial'.
//
// LIMITATIONS (no enforcer, stated): the schema is the world's own; a type the
// model invents is dropped and counted, never proposed as a schema change.
// Memory files and named folders are re-read on every re-run (only sessions are
// watermarked); facts already stored come back as `duplicate` skips on save.

import { AUTHORITATIVE_AUTHORS, type Entity, type GraphBundle } from '@ethosagent/types';
import { z } from 'zod';
import type { ResolvedWorld } from '../access';
import { canonicalJson } from '../schema-model';
import type { WorldSchemaService } from '../schema-service';
import { type Caller, type WorldService, WorldServiceError } from '../service';
import type { BuildItemInput, BuildRow, SQLiteWorldServiceStore } from '../service-store';
import { type CompleteFn, type ExtractedEntity, extractChunk } from './extract';
import { type MergedEntity, mergeEntities, normName } from './merge';
import { type BuildSourceDeps, collectBuildInputs } from './sources';

/** A refusal the user can act on (wrong status, nothing staged, no schema). */
export class WorldBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorldBuildError';
  }
}

export interface WorldBuildDeps {
  service: WorldService;
  store: SQLiteWorldServiceStore;
  schema: WorldSchemaService;
  /** Memory, sessions and the shared-turn predicate. `readFolder` comes from the turn (`BuildIO`). */
  sources: Omit<BuildSourceDeps, 'readFolder'>;
  /** One metered auxiliary model call. */
  complete: CompleteFn;
  /** `AgentSafety.injection.wrapUntrusted`, bound in wiring. */
  wrap: (text: string, source: string) => string;
  /** Dollars for a token count on the extraction model (`estimateCost`, bound in wiring). */
  price: (inputTokens: number, outputTokens: number) => number;
  onError?: (e: unknown) => void;
}

/** What only the current turn can supply: its own fs reach. */
export interface BuildIO {
  readFolder: BuildSourceDeps['readFolder'];
}

export type BuildRequest =
  | { action: 'estimate'; folders: string[] }
  | { action: 'run'; buildId: string }
  | { action: 'save'; buildId: string; choice: 'all' | 'sure_only' | 'discard' };

export interface EstimateResult {
  action: 'estimate';
  buildId: string;
  world: string;
  memoryFiles: number;
  sessions: number;
  files: number;
  estimateUsd: number;
  refused: string[];
}
export interface RunResult {
  action: 'run';
  buildId: string;
  world: string;
  /** Entity count per type, e.g. `{ Person: 42 }`. */
  entities: Record<string, number>;
  links: number;
  duplicates: number;
  conflicts: number;
  /** The budget cap stopped the build; what was staged is still saved on request. */
  partial: boolean;
  spentUsd: number;
}
export interface SaveResult {
  action: 'save';
  buildId: string;
  world: string;
  choice: 'all' | 'sure_only' | 'discard';
  applied: number;
  proposed: number;
  skipped: number;
  shared: boolean;
}
export type BuildReply = EstimateResult | RunResult | SaveResult;

const PROMPT_TOKENS = 500;
const OUT_TOKENS = 400;
const BUDGET_FACTOR = 1.2;
const SURE_CONFIDENCE = 0.7;

const SummaryZ = z.object({
  folders: z.array(z.string()),
  fromSince: z.string().nullable(),
  memoryFiles: z.number(),
  sessions: z.number(),
  files: z.number(),
  refused: z.array(z.string()),
  stats: z
    .object({
      entities: z.record(z.string(), z.number()),
      links: z.number(),
      duplicates: z.number(),
      conflicts: z.number(),
      partial: z.boolean(),
    })
    .optional(),
});
type Summary = z.infer<typeof SummaryZ>;

const WatermarkZ = z.object({ sessionsSince: z.string().nullable() });

const refZ = z.object({ type: z.string(), name: z.string() });
const FactItemZ = z.discriminatedUnion('fact', [
  z.object({
    fact: z.literal('entity'),
    type: z.string(),
    name: z.string(),
    aliases: z.array(z.string()),
  }),
  z.object({
    fact: z.literal('attribute'),
    entity: refZ,
    key: z.string(),
    value: z.union([z.string(), z.number(), z.boolean()]),
    confidence: z.number(),
  }),
  z.object({
    fact: z.literal('edge'),
    type: z.string(),
    from: refZ,
    to: refZ,
    confidence: z.number(),
  }),
]);
const ConflictItemZ = z.object({
  entity: refZ,
  key: z.string(),
  value: z.union([z.string(), z.number(), z.boolean()]),
  confidence: z.number(),
  existing: z.object({ factId: z.string(), value: z.unknown() }),
});

const label = (w: Pick<ResolvedWorld, 'alias' | 'tag'>): string => w.alias ?? w.tag;

export class WorldBuildService {
  constructor(private readonly deps: WorldBuildDeps) {}

  async handle(
    c: Caller,
    worldRef: string | null,
    req: BuildRequest,
    io: BuildIO,
  ): Promise<BuildReply> {
    const caller: Caller = { ...c, surface: 'build' };
    if (caller.audience !== 'private') {
      throw new WorldBuildError('a first build runs only in a private turn');
    }
    switch (req.action) {
      case 'estimate':
        return this.estimate(caller, worldRef, req.folders, io);
      case 'run':
        return this.run(caller, req.buildId, io);
      case 'save':
        return this.save(caller, req.buildId, req.choice);
    }
  }

  private async target(c: Caller, ref: string | null): Promise<ResolvedWorld> {
    const visible = await this.deps.service.visible(c);
    const hit =
      ref === null
        ? visible.length === 1
          ? visible[0]
          : undefined
        : visible.find((w) => w.alias === ref || w.tag === ref || w.id === ref);
    if (!hit) {
      const names = visible.map(label).join(', ') || 'none';
      throw new WorldServiceError(
        ref === null && visible.length > 1 ? 'WORLD_REQUIRED' : 'not_mounted',
        ref === null && visible.length > 1
          ? `name a world; visible: ${names}`
          : `'${ref ?? ''}' is not visible to this turn (visible: ${names})`,
      );
    }
    if (hit.mode === 'read') {
      throw new WorldBuildError(`world '${label(hit)}' is mounted read-only`);
    }
    return hit;
  }

  /** The build, only for the personality that made it and a world it still sees. */
  private async own(
    c: Caller,
    buildId: string,
  ): Promise<{ build: BuildRow; world: ResolvedWorld }> {
    const build = this.deps.store.getBuild(buildId);
    if (!build || build.personalityId !== c.personalityId) {
      throw new WorldBuildError(`no build ${buildId} for this personality`);
    }
    const world = (await this.deps.service.visible(c)).find((w) => w.id === build.world);
    if (!world) throw new WorldBuildError(`world of build ${buildId} is not visible to this turn`);
    return { build, world };
  }

  private sources(io: BuildIO): BuildSourceDeps {
    return { ...this.deps.sources, readFolder: io.readFolder };
  }

  // ---- estimate ----------------------------------------------------------------

  private async estimate(
    c: Caller,
    worldRef: string | null,
    folders: string[],
    io: BuildIO,
  ): Promise<EstimateResult> {
    const w = await this.target(c, worldRef);
    const fromSince = this.watermarkOf(this.deps.store.lastSavedWatermark(w.id, c.personalityId));
    const memory = new Set<string>();
    const sessions = new Set<string>();
    const files = new Set<string>();
    const refused: string[] = [];
    let chars = 0;
    let chunks = 0;
    let newest = fromSince;
    for await (const ch of collectBuildInputs(this.sources(io), {
      personalityId: c.personalityId,
      folders,
      watermark: { sessionsSince: fromSince },
    })) {
      if (ch.refused !== undefined) {
        refused.push(ch.refused);
        continue;
      }
      chunks++;
      chars += ch.text.length;
      if (ch.kind === 'memory') memory.add(ch.sourceRef);
      else if (ch.kind === 'session') sessions.add(ch.sourceRef);
      else files.add(ch.sourceRef);
      if (ch.at !== undefined && (newest === null || ch.at > newest)) newest = ch.at;
    }
    const inputTokens = Math.ceil(chars / 4) + chunks * PROMPT_TOKENS;
    const estimateUsd = this.deps.price(inputTokens, chunks * OUT_TOKENS);
    const summary: Summary = {
      folders,
      fromSince,
      memoryFiles: memory.size,
      sessions: sessions.size,
      files: files.size,
      refused,
    };
    const buildId = this.deps.store.insertBuild({
      world: w.id,
      personalityId: c.personalityId,
      estimateUsd,
      summary,
      watermark: { sessionsSince: newest },
    });
    return {
      action: 'estimate',
      buildId,
      world: label(w),
      memoryFiles: memory.size,
      sessions: sessions.size,
      files: files.size,
      estimateUsd,
      refused,
    };
  }

  private watermarkOf(raw: unknown): string | null {
    const p = WatermarkZ.safeParse(raw);
    return p.success ? p.data.sessionsSince : null;
  }

  // ---- run -----------------------------------------------------------------------

  private async run(c: Caller, buildId: string, io: BuildIO): Promise<RunResult> {
    const { build, world } = await this.own(c, buildId);
    if (build.status !== 'estimated') {
      throw new WorldBuildError(
        `build ${buildId} is ${build.status}; start from an estimate to run it`,
      );
    }
    const summary = SummaryZ.safeParse(build.summary);
    if (!summary.success) throw new WorldBuildError(`build ${buildId} has an unreadable estimate`);
    const loaded = await this.deps.schema.load(world.id);
    if (Object.keys(loaded.schema.entities).length === 0) {
      throw new WorldBuildError(
        `world '${label(world)}' has no schema yet; add entity types before building`,
      );
    }

    const cap = (build.estimateUsd ?? 0) * BUDGET_FACTOR;
    const entities: ExtractedEntity[] = [];
    const attributes: Awaited<ReturnType<typeof extractChunk>>['attributes'] = [];
    const links: Awaited<ReturnType<typeof extractChunk>>['links'] = [];
    let spent = 0;
    let partial = false;
    let newest = summary.data.fromSince;
    const failures: unknown[] = [];

    for await (const ch of collectBuildInputs(this.sources(io), {
      personalityId: c.personalityId,
      folders: summary.data.folders,
      watermark: { sessionsSince: summary.data.fromSince },
    })) {
      if (ch.refused !== undefined) continue;
      if (ch.at !== undefined && (newest === null || ch.at > newest)) newest = ch.at;
      if (cap > 0 && spent >= cap) {
        partial = true;
        continue; // keep scanning only for the watermark; no more calls
      }
      try {
        const x = await extractChunk(ch, loaded.schema, {
          complete: this.deps.complete,
          wrap: this.deps.wrap,
          sensitive: loaded.sensitive,
        });
        spent += this.deps.price(x.inputTokens, x.outputTokens);
        entities.push(...x.entities);
        attributes.push(...x.attributes);
        links.push(...x.links);
      } catch (e) {
        failures.push(e);
        this.deps.onError?.(e);
      }
    }
    if (failures.length > 0 && entities.length === 0 && attributes.length === 0) {
      this.deps.store.updateBuild(buildId, { status: 'failed', spentUsd: spent });
      throw new WorldBuildError(
        `the extraction model failed ${failures.length} time(s); nothing staged`,
      );
    }

    const live = await this.liveBundle(c, world);
    const staged = this.stage(entities, attributes, links, live);
    this.deps.store.replaceBuildItems(buildId, staged.items);
    const stats = {
      entities: staged.byType,
      links: staged.linkCount,
      duplicates: staged.duplicates,
      conflicts: staged.conflicts,
      partial,
    };
    this.deps.store.updateBuild(buildId, {
      status: partial ? 'failed' : 'staged',
      spentUsd: spent,
      summary: { ...summary.data, stats },
      // A partial build did not read everything, so the next build starts from the old mark.
      watermark: { sessionsSince: partial ? summary.data.fromSince : newest },
    });
    return {
      action: 'run',
      buildId,
      world: label(world),
      entities: staged.byType,
      links: staged.linkCount,
      duplicates: staged.duplicates,
      conflicts: staged.conflicts,
      partial,
      spentUsd: spent,
    };
  }

  private async liveBundle(c: Caller, w: ResolvedWorld): Promise<GraphBundle> {
    return this.deps.service.exportBundle(c, label(w));
  }

  private stage(
    rawEntities: Parameters<typeof mergeEntities>[0],
    rawAttrs: Array<{
      entity: { type: string; name: string };
      key: string;
      value: string | number | boolean;
      sourceRef: string;
      confidence: number;
    }>,
    rawLinks: Array<{
      type: string;
      from: { type: string; name: string };
      to: { type: string; name: string };
      sourceRef: string;
      confidence: number;
    }>,
    live: GraphBundle,
  ): {
    items: BuildItemInput[];
    byType: Record<string, number>;
    linkCount: number;
    duplicates: number;
    conflicts: number;
  } {
    const { entities, duplicates } = mergeEntities(rawEntities);
    const unsure = new Set(duplicates.map((d) => `${d.type}\u0000${normName(d.unsure)}`));
    const keyOf = (e: Pick<MergedEntity, 'type' | 'name'>): string =>
      `${e.type}\u0000${normName(e.name)}`;
    const resolve = (ref: { type: string; name: string }): MergedEntity | undefined => {
      const k = `n:${normName(ref.name)}`;
      return entities.find((g) => g.type === ref.type && g.keys.has(k));
    };

    const items: BuildItemInput[] = [];
    const byType: Record<string, number> = {};
    for (const g of entities) {
      byType[g.type] = (byType[g.type] ?? 0) + 1;
      items.push({
        kind: 'fact',
        payload: { fact: 'entity', type: g.type, name: g.name, aliases: g.aliases },
        sure: g.confidence >= SURE_CONFIDENCE && !unsure.has(keyOf(g)),
        sourceRef: g.sourceRef,
      });
    }
    const isUnsure = (g: MergedEntity): boolean => unsure.has(keyOf(g));

    // Live user/import attributes, by entity, for the contradiction check.
    const liveByRef = new Map<string, Entity>();
    for (const e of live.entities) {
      if (e.retiredAt !== null || e.mergedInto !== null) continue;
      for (const n of [e.name, ...e.aliases]) liveByRef.set(`${e.type}\u0000${normName(n)}`, e);
    }
    const authoritative = live.attributes.filter(
      (a) => AUTHORITATIVE_AUTHORS.includes(a.author) && a.retiredAt === null && a.validTo === null,
    );

    const seenAttr = new Map<string, number>();
    let conflicts = 0;
    for (const a of rawAttrs) {
      const g = resolve(a.entity);
      if (!g) continue;
      const liveEntity =
        liveByRef.get(keyOf(g)) ?? liveByRef.get(`${g.type}\u0000${normName(a.entity.name)}`);
      const clash = liveEntity
        ? authoritative.find(
            (x) =>
              x.entityId === liveEntity.id &&
              x.key === a.key &&
              canonicalJson(x.value) !== canonicalJson(a.value),
          )
        : undefined;
      const ref = { type: g.type, name: g.name };
      if (clash) {
        conflicts++;
        items.push({
          kind: 'conflict',
          payload: {
            entity: ref,
            key: a.key,
            value: a.value,
            confidence: a.confidence,
            existing: { factId: clash.id, value: clash.value },
          },
          sure: false,
          sourceRef: a.sourceRef,
        });
        continue;
      }
      const dedup = `${keyOf(g)}\u0000${a.key}\u0000${canonicalJson(a.value)}`;
      if (seenAttr.has(dedup)) continue;
      seenAttr.set(dedup, items.length);
      items.push({
        kind: 'fact',
        payload: {
          fact: 'attribute',
          entity: ref,
          key: a.key,
          value: a.value,
          confidence: a.confidence,
        },
        sure: a.confidence >= SURE_CONFIDENCE && !isUnsure(g),
        sourceRef: a.sourceRef,
      });
    }

    const seenEdge = new Set<string>();
    let linkCount = 0;
    for (const l of rawLinks) {
      const from = resolve(l.from);
      const to = resolve(l.to);
      if (!from || !to) continue;
      const dedup = `${l.type}\u0000${keyOf(from)}\u0000${keyOf(to)}`;
      if (seenEdge.has(dedup)) continue;
      seenEdge.add(dedup);
      linkCount++;
      items.push({
        kind: 'fact',
        payload: {
          fact: 'edge',
          type: l.type,
          from: { type: from.type, name: from.name },
          to: { type: to.type, name: to.name },
          confidence: l.confidence,
        },
        sure: l.confidence >= SURE_CONFIDENCE && !isUnsure(from) && !isUnsure(to),
        sourceRef: l.sourceRef,
      });
    }
    for (const d of duplicates) {
      items.push({ kind: 'duplicate', payload: d, sure: false, sourceRef: 'build:merge' });
    }
    return { items, byType, linkCount, duplicates: duplicates.length, conflicts };
  }

  // ---- save ----------------------------------------------------------------------

  private async save(
    c: Caller,
    buildId: string,
    choice: 'all' | 'sure_only' | 'discard',
  ): Promise<SaveResult> {
    const { build, world } = await this.own(c, buildId);
    const result = (r: Partial<SaveResult>): SaveResult => ({
      action: 'save',
      buildId,
      world: label(world),
      choice,
      applied: 0,
      proposed: 0,
      skipped: 0,
      shared: world.shared,
      ...r,
    });
    const items = this.deps.store.listBuildItems(buildId);
    const savable = build.status === 'staged' || (build.status === 'failed' && items.length > 0);
    if (!savable) {
      throw new WorldBuildError(
        `build ${buildId} has no staged results (status ${build.status}); run it first`,
      );
    }
    if (choice === 'discard') {
      this.deps.store.updateBuild(buildId, { status: 'discarded', decided: true });
      return result({});
    }

    const bundle = this.toBundle(world.id, items, choice === 'sure_only');
    const out = await this.deps.service.importBundle(c, label(world), bundle);
    this.deps.store.updateBuild(buildId, { status: 'saved', decided: true });
    return result({
      applied: out.applied,
      proposed: out.proposed,
      skipped: out.report.skipped.length,
    });
  }

  /** Staged items as a bundle with synthetic ids; `importBundle` resolves them to real ones. */
  private toBundle(
    world: ResolvedWorld['id'],
    items: ReturnType<SQLiteWorldServiceStore['listBuildItems']>,
    sureOnly: boolean,
  ): GraphBundle {
    const at = new Date().toISOString();
    const ids = new Map<string, string>();
    const bundle: GraphBundle = { schema: null, entities: [], attributes: [], edges: [] };
    const idOf = (r: { type: string; name: string }): string | undefined =>
      ids.get(`${r.type}\u0000${normName(r.name)}`);
    const common = (sourceRef: string) =>
      ({ world, recordedAt: at, retiredAt: null, sourceRef, author: 'agent' }) as const;

    const picked = items.filter(
      (i) => (i.kind === 'fact' || (!sureOnly && i.kind === 'conflict')) && (!sureOnly || i.sure),
    );
    for (const it of picked) {
      const f = FactItemZ.safeParse(it.payload);
      if (!f.success || f.data.fact !== 'entity') continue;
      const id = `b${ids.size + 1}`;
      ids.set(`${f.data.type}\u0000${normName(f.data.name)}`, id);
      bundle.entities.push({
        id,
        type: f.data.type,
        name: f.data.name,
        aliases: f.data.aliases,
        mergedInto: null,
        ...common(it.sourceRef),
      });
    }
    for (const it of picked) {
      if (it.kind === 'conflict') {
        const k = ConflictItemZ.safeParse(it.payload);
        const entityId = k.success ? idOf(k.data.entity) : undefined;
        if (!k.success || entityId === undefined) continue;
        bundle.attributes.push({
          id: `a${bundle.attributes.length + 1}`,
          entityId,
          key: k.data.key,
          value: k.data.value,
          validFrom: null,
          validTo: null,
          confidence: k.data.confidence,
          ...common(it.sourceRef),
        });
        continue;
      }
      const f = FactItemZ.safeParse(it.payload);
      if (!f.success) continue;
      if (f.data.fact === 'attribute') {
        const entityId = idOf(f.data.entity);
        if (entityId === undefined) continue;
        bundle.attributes.push({
          id: `a${bundle.attributes.length + 1}`,
          entityId,
          key: f.data.key,
          value: f.data.value,
          validFrom: null,
          validTo: null,
          confidence: f.data.confidence,
          ...common(it.sourceRef),
        });
      } else if (f.data.fact === 'edge') {
        const fromId = idOf(f.data.from);
        const toId = idOf(f.data.to);
        if (fromId === undefined || toId === undefined) continue;
        bundle.edges.push({
          id: `x${bundle.edges.length + 1}`,
          type: f.data.type,
          fromId,
          toId,
          attrs: {},
          validFrom: null,
          validTo: null,
          confidence: f.data.confidence,
          ...common(it.sourceRef),
        });
      }
    }
    return bundle;
  }
}
