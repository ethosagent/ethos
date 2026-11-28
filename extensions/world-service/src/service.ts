// WorldService: the one place a world is read or written (plan world-model
// Task 2.4). A WorldGraphProvider stores facts; this class decides who may see
// them, which writes land and which become proposals.
//
// Single owner of live facts in a backend (plan Global Constraints): the
// direct writers are `writeFacts` (agent, private world only), `acceptProposal`,
// `promoteToUser`, `ownerWrite`/`ownerImport` and `purge` (owner surfaces). No
// tool and no injector holds a provider: `createWorldToolPort` (port.ts) hands
// tools a frozen object of methods bound to this class, and
// `__tests__/world-port.test.ts` 'R13 tool port is narrow' pins that.
//
// Guarantees and what pins them, in `__tests__/`:
//   - R1: an agent write or close on a shared world is a proposal, the backend
//     is untouched: write-routing.test.ts 'R1 shared-world writes are
//     proposals only', 'R1 a close on a shared world is a proposal too'.
//   - R2: a user or import fact is never overwritten or closed by the agent;
//     a conflict proposal is created instead, on private and shared worlds:
//     'R2 user facts are never overwritten by the agent', 'R2 an attribute
//     with a different value than a user fact becomes a conflict proposal',
//     'agent closing a user fact becomes a conflict proposal'. The author of a
//     tool write is forced to `agent` here, never taken from the caller:
//     'an agent cannot claim the user author'.
//   - R9: no world named with 2+ visible worlds is refused WORLD_REQUIRED:
//     'R9 null world with 2+ visible worlds → WORLD_REQUIRED'.
//   - R11: secrets and personal data are refused before anything is written or
//     proposed (vetting.ts): fact-vetting.test.ts.
//   - Confidence under 0.7 on a private world is a proposal: 'low confidence
//     on a private world becomes a proposal'.
//   - A rejected fact is not proposed again: 'rejectProposal tombstones, so the
//     same write is not proposed again'.
//   - A truncated duplicate or unique-edge lookup is re-queried with a growing
//     limit (lookup.ts) and, if the set is still unseen at the ceiling, the
//     write is refused `lookup_incomplete`: lookup-paging.test.ts 'refuses
//     lookup_incomplete when the ceiling is hit without seeing the whole
//     unique-edge set'.
//
// LIMITATIONS (no enforcer, stated):
//   - Every fact is asserted on its own (one provider call per fact) so a
//     refusal is reported per fact; the backend's batch atomicity is not used.
//   - `exportBundle` reads `provider.export` behind the same `visible` check
//     as `query`, because `query` is limit-bound and cannot enumerate a world.
//   - Closed historic facts in a bundle are not imported (`FactInput` carries
//     no `validTo`): only live facts are.

import { randomBytes } from 'node:crypto';
import { detectSecrets } from '@ethosagent/safety-redact';
import {
  type AttributeFact,
  AUTHORITATIVE_AUTHORS,
  type ChangeRow,
  type Edge,
  type Entity,
  type FactAuthor,
  type FactInput,
  type Facts,
  type GraphBundle,
  type GraphQuery,
  type ImportReport,
  type Subgraph,
  type TimeSlice,
  type TurnAudience,
  type WorldGraphProvider,
  type WorldId,
  type WorldSchema,
} from '@ethosagent/types';
import { displayTag, type ResolvedWorld, resolveAccess } from './access';
import type { WorldConfigService } from './config-service';
import { lookupIncomplete, pagedLookup } from './lookup';
import {
  type EntityRef,
  parseAssertPayload,
  parseClosePayload,
  parseSchemaPayload,
} from './proposal-payload';
import type { SchemaChange } from './schema-diff';
import { canonicalJson } from './schema-model';
import type { WorldSchemaService } from './schema-service';
import type { BuildItemRow, BuildRow, ProposalRow, SQLiteWorldServiceStore } from './service-store';
import { vetFact } from './vetting';

export interface Caller {
  personalityId: string;
  audience: TurnAudience | undefined;
  sessionId: string | null;
  surface: 'tool' | 'extraction' | 'build' | 'feed' | 'owner';
}

export interface WorldServiceDeps {
  providers: (w: WorldId) => Promise<WorldGraphProvider>;
  schema: WorldSchemaService;
  store: SQLiteWorldServiceStore;
  config: WorldConfigService;
  now?: () => number;
  /** Most rows one write-deciding lookup may read before the write is refused (default LOOKUP_CEILING in lookup.ts). */
  lookupCeiling?: number;
  onError?: (e: unknown) => void;
}

/** R8: every result names its world. `tag` is the mount alias when set, else the world slug. */
export type Tagged<T> = T & { tag: string };
export type TaggedEntity = Tagged<Entity> & { displayTag: string };

export interface TaggedFacts {
  entities: TaggedEntity[];
  attributes: Array<Tagged<AttributeFact>>;
  edges: Array<Tagged<Edge>>;
  paths?: string[][];
  truncated: boolean;
}

export interface WriteOutcome {
  applied: string[];
  /** Facts a conflict proposal closed on accept (`acceptProposal` only). */
  closed?: string[];
  proposed: string[];
  refused: Array<{ index: number; reason: string }>;
  /** One line per proposal that conflicts with a user or import fact (R2), for the tool reply. */
  conflicts?: string[];
}

export interface ImportOutcome {
  report: ImportReport;
  applied: number;
  proposed: number;
}

export type SchemaRequestOutcome =
  | { applied: number }
  | { proposalId: string }
  | { refused: string };

/** A read the caller may not make: `WORLD_REQUIRED` (name a world) or `not_mounted`. */
export class WorldServiceError extends Error {
  readonly code: 'WORLD_REQUIRED' | 'not_mounted' | 'not_pending';
  constructor(code: WorldServiceError['code'], message: string) {
    super(`${code}: ${message}`);
    this.name = 'WorldServiceError';
    this.code = code;
  }
}

/** Below this an agent's fact on a private world is a proposal (the skill's "ask when under 0.7"). */
const MIN_DIRECT_CONFIDENCE = 0.7;

type Target = Pick<ResolvedWorld, 'id' | 'shared'>;

interface Existing {
  id: string;
  author: FactAuthor;
  validFrom: string | null;
  validTo: string | null;
}

interface Analysis {
  duplicateOf: string | null;
  colliding: Existing[];
  /** Set when the candidate set could not be seen in full; the write must be refused. */
  incomplete?: string;
}

type Placement =
  | { kind: 'applied'; ids: string[] }
  | { kind: 'proposed'; id: string; conflict?: string }
  | { kind: 'refused'; reason: string; existingId?: string };

interface PlaceCtx {
  actor: 'agent' | 'owner';
  /** The author stamped on every fact; the fact's own `author` is ignored. */
  author: FactAuthor;
  by: string;
  sessionId: string | null;
  why: string;
  schema: WorldSchema;
  sensitive: readonly string[];
  force?: 'propose';
  batchId: () => string;
}

const label = (w: Pick<ResolvedWorld, 'alias' | 'tag'>): string => w.alias ?? w.tag;

function describeFact(f: FactInput): string {
  switch (f.kind) {
    case 'entity':
      return `add ${f.type} "${f.name}"`;
    case 'attribute': {
      const v = JSON.stringify(f.value) ?? 'null';
      return `set ${f.key} = ${v.length > 80 ? `${v.slice(0, 77)}...` : v} on ${f.entityId}`;
    }
    case 'edge':
      return `add ${f.type}: ${f.fromId} -> ${f.toId}`;
  }
}

const confidenceOf = (f: FactInput): number => (f.kind === 'entity' ? 1 : f.confidence);

const allRefused = (facts: readonly unknown[], reason: string): WriteOutcome => ({
  applied: [],
  proposed: [],
  refused: facts.map((_, index) => ({ index, reason })),
});

/** Row-open: valid_to unset and not retired. `closeFact` refuses anything else. */
const live = (f: { retiredAt: string | null; validTo: string | null }): boolean =>
  f.retiredAt === null && f.validTo === null;

/**
 * Still true at `asOf` on the world clock. Matches WORLD_SQL in
 * extensions/world-sqlite/src/store.ts: `(valid_to IS NULL OR valid_to > asOf)`.
 * Equal means the fact has ended.
 */
const holding = (f: { retiredAt: string | null; validTo: string | null }, asOf: string): boolean =>
  f.retiredAt === null && (f.validTo === null || f.validTo > asOf);

/**
 * Date a replaced fact is closed on. `requested` is the new fact's validFrom
 * (or today / the proposal date when it has none). Never earlier than the old
 * fact's validFrom: `SQLiteWorldGraphProvider.close` refuses validTo < valid_from.
 */
function closeDate(requested: string, oldValidFrom: string | null): string {
  return oldValidFrom !== null && oldValidFrom > requested ? oldValidFrom : requested;
}

type Picked =
  | { ok: true; w: ResolvedWorld }
  | { ok: false; reason: string; code: 'WORLD_REQUIRED' | 'not_mounted' };

/** `null` names no world: fine with exactly one visible world, WORLD_REQUIRED with more (R9). */
function pick(visible: readonly ResolvedWorld[], ref: string | null): Picked {
  const tags = visible.map(label);
  if (ref === null) {
    const only = visible[0];
    if (visible.length === 1 && only) return { ok: true, w: only };
    if (visible.length === 0) {
      return {
        ok: false,
        code: 'not_mounted',
        reason: 'not_mounted: no world is visible to this turn',
      };
    }
    return {
      ok: false,
      code: 'WORLD_REQUIRED',
      reason: `WORLD_REQUIRED: name a world; visible: ${tags.join(', ')}`,
    };
  }
  const w = visible.find((v) => v.alias === ref || v.tag === ref || v.id === ref);
  if (w) return { ok: true, w };
  return {
    ok: false,
    code: 'not_mounted',
    reason: `not_mounted: '${ref}' is not visible to this turn (visible: ${tags.join(', ') || 'none'})`,
  };
}

export class WorldService {
  private readonly deps: WorldServiceDeps;
  private readonly now: () => number;

  constructor(deps: WorldServiceDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  private today(): string {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  private fail(e: unknown): void {
    this.deps.onError?.(e);
  }

  // ---- reads ---------------------------------------------------------------

  /** `resolveAccess`, once per call: mounts, grants and the turn's audience. */
  async visible(c: Caller): Promise<ResolvedWorld[]> {
    const [worlds, mounts] = await Promise.all([
      this.deps.config.listWorlds(),
      this.deps.config.readMounts(c.personalityId),
    ]);
    return resolveAccess({
      personalityId: c.personalityId,
      audience: c.audience,
      mounts,
      worlds,
    }).visible;
  }

  /** Throws `WorldServiceError` when `world` names nothing visible or is ambiguous. */
  private async one(c: Caller, world: string | null): Promise<ResolvedWorld> {
    const p = pick(await this.visible(c), world);
    if (!p.ok) throw new WorldServiceError(p.code, p.reason.slice(p.code.length + 2));
    return p.w;
  }

  private tag(w: ResolvedWorld, f: Facts): TaggedFacts {
    const tag = label(w);
    return {
      entities: f.entities.map((e) => ({ ...e, tag, displayTag: displayTag(w, e.name) })),
      attributes: f.attributes.map((a) => ({ ...a, tag })),
      edges: f.edges.map((e) => ({ ...e, tag })),
      ...(f.paths ? { paths: f.paths } : {}),
      truncated: f.truncated,
    };
  }

  /** `world` null spans every visible world (R8: each result is tagged with its own). */
  async query(
    c: Caller,
    world: string | null,
    q: GraphQuery,
    slice?: TimeSlice,
  ): Promise<TaggedFacts> {
    const visible = await this.visible(c);
    let targets = visible;
    if (world !== null) {
      const p = pick(visible, world);
      if (!p.ok) throw new WorldServiceError(p.code, p.reason.slice(p.code.length + 2));
      targets = [p.w];
    }
    const merged: TaggedFacts = { entities: [], attributes: [], edges: [], truncated: false };
    for (const w of targets) {
      const provider = await this.deps.providers(w.id);
      const t = this.tag(w, await provider.query(w.id, q, slice));
      merged.entities.push(...t.entities);
      merged.attributes.push(...t.attributes);
      merged.edges.push(...t.edges);
      if (t.paths) merged.paths = [...(merged.paths ?? []), ...t.paths];
      merged.truncated ||= t.truncated;
    }
    return merged;
  }

  async neighbours(
    c: Caller,
    world: string | null,
    ref: string,
    hops: number,
    slice?: TimeSlice,
  ): Promise<TaggedFacts> {
    const w = await this.one(c, world);
    const provider = await this.deps.providers(w.id);
    return this.tag(w, await provider.neighbours(w.id, ref, hops, slice));
  }

  async history(c: Caller, world: string, ref: string): Promise<TaggedFacts> {
    const w = await this.one(c, world);
    const provider = await this.deps.providers(w.id);
    const h = await provider.history(w.id, ref);
    return this.tag(w, {
      entities: [],
      attributes: h.attributes,
      edges: h.edges,
      truncated: false,
    });
  }

  // ---- agent writes --------------------------------------------------------

  async writeFacts(
    c: Caller,
    world: string | null,
    facts: FactInput[],
    why: string,
  ): Promise<WriteOutcome> {
    return this.agentWrite(c, world, facts, why, undefined);
  }

  /** Like `writeFacts`, but every fact becomes a proposal, even on the private world. */
  async proposeFacts(
    c: Caller,
    world: string | null,
    facts: FactInput[],
    why: string,
  ): Promise<WriteOutcome> {
    return this.agentWrite(c, world, facts, why, 'propose');
  }

  private async agentWrite(
    c: Caller,
    world: string | null,
    facts: FactInput[],
    why: string,
    force: 'propose' | undefined,
  ): Promise<WriteOutcome> {
    // Steps 1 and 2: resolve the world, refuse a read-only mount.
    const p = pick(await this.visible(c), world);
    if (!p.ok) return allRefused(facts, p.reason);
    const w = p.w;
    if (w.mode === 'read') {
      return allRefused(facts, `read_only: world '${label(w)}' is mounted read-only`);
    }
    const ctx = await this.agentCtx(c, w, why, force);
    const provider = await this.deps.providers(w.id);
    const out: WriteOutcome = { applied: [], proposed: [], refused: [] };
    for (const [index, fact] of facts.entries()) {
      const r = await this.place(provider, w, fact, ctx);
      if (r.kind === 'applied') out.applied.push(...r.ids);
      else if (r.kind === 'proposed') {
        out.proposed.push(r.id);
        if (r.conflict) out.conflicts = [...(out.conflicts ?? []), r.conflict];
      } else out.refused.push({ index, reason: r.reason });
    }
    return out;
  }

  private async agentCtx(
    c: Caller,
    w: ResolvedWorld,
    why: string,
    force: 'propose' | undefined,
  ): Promise<PlaceCtx> {
    const loaded = await this.deps.schema.load(w.id);
    let batch: string | null = null;
    return {
      actor: 'agent',
      // The tool's claimed author is never trusted: R2 rests on this.
      author: c.surface === 'feed' ? 'connector' : 'agent',
      by: c.personalityId,
      sessionId: c.sessionId,
      why,
      schema: loaded.schema,
      sensitive: loaded.sensitive,
      ...(force ? { force } : {}),
      batchId: () => {
        batch ??= `b-${randomBytes(6).toString('hex')}`;
        return batch;
      },
    };
  }

  /**
   * Steps 3 to 6 for one fact: vet, find duplicates and collisions, then route
   * to a proposal or a direct write. The owner never proposes and closes what
   * the new fact replaces.
   */
  private async place(
    provider: WorldGraphProvider,
    target: Target,
    input: FactInput,
    ctx: PlaceCtx,
    refs: { entityId?: EntityRef; fromId?: EntityRef; toId?: EntityRef } = {},
  ): Promise<Placement> {
    const fact: FactInput = { ...input, author: ctx.author };
    const vet = vetFact(fact, { schema: ctx.schema, sensitive: ctx.sensitive, actor: ctx.actor });
    if (!vet.ok) return { kind: 'refused', reason: `vetting: ${vet.reason}` };

    const hasRefs = Object.keys(refs).length > 0;
    const found = hasRefs
      ? { duplicateOf: null, colliding: [] }
      : await this.analyse(provider, target.id, fact, ctx.schema);
    if (found.incomplete !== undefined) return { kind: 'refused', reason: found.incomplete };
    if (found.duplicateOf !== null) {
      return {
        kind: 'refused',
        reason: `duplicate: already stored as ${found.duplicateOf}`,
        existingId: found.duplicateOf,
      };
    }

    if (ctx.actor === 'agent') {
      const authoritative = found.colliding.find((e) => AUTHORITATIVE_AUTHORS.includes(e.author));
      const mustPropose =
        ctx.force === 'propose' ||
        target.shared || // R1
        hasRefs ||
        authoritative !== undefined || // R2
        confidenceOf(fact) < MIN_DIRECT_CONFIDENCE;
      if (mustPropose) {
        return this.propose(
          target.id,
          'assert',
          { fact, closes: found.colliding.map((e) => e.id), refs },
          authoritative?.id ?? null,
          ctx,
        );
      }
    }

    // A fact that already has validTo cannot be closed again. Refuse before
    // assert so a second overlapping row is never written. Do not call fail.
    const sealed = found.colliding.find((e) => e.validTo !== null);
    if (sealed) {
      return {
        kind: 'refused',
        reason: `overlap: fact ${sealed.id} already has validTo ${sealed.validTo}`,
      };
    }

    const r = await provider.assert(target.id, [fact]);
    if (!r.ok) return { kind: 'refused', reason: `${r.code}: ${r.reason}` };
    const requested = fact.kind === 'entity' ? this.today() : (fact.validFrom ?? this.today());
    for (const old of found.colliding) {
      const at = closeDate(requested, old.validFrom);
      const closed = await provider.close(target.id, old.id, at, fact.sourceRef, ctx.author);
      if (!closed.ok)
        this.fail(new Error(`could not close ${old.id}: ${closed.code}: ${closed.reason}`));
    }
    return { kind: 'applied', ids: r.ids };
  }

  private propose(
    world: WorldId,
    kind: 'assert' | 'close',
    payload: object,
    conflictWith: string | null,
    ctx: PlaceCtx,
    summary?: string,
    confidence?: number,
  ): Placement {
    const fact = 'fact' in payload ? (payload.fact as FactInput) : null;
    const base = summary ?? (fact ? describeFact(fact) : kind);
    const queued = this.deps.store.propose({
      world,
      kind,
      payload,
      summary: ctx.why ? `${base} (${ctx.why})` : base,
      conflictWith,
      sourceRef: fact?.sourceRef ?? 'world:close',
      proposedBy: ctx.by,
      sessionId: ctx.sessionId,
      confidence: confidence ?? (fact ? confidenceOf(fact) : 1),
      batchId: ctx.batchId(),
    });
    if ('refused' in queued) {
      return { kind: 'refused', reason: 'rejected: the owner already rejected this fact' };
    }
    return {
      kind: 'proposed',
      id: queued.id,
      ...(conflictWith !== null ? { conflict: base } : {}),
    };
  }

  /** Is the fact already stored, and which live facts does it replace (unique edges, same-key attributes)? */
  private async analyse(
    provider: WorldGraphProvider,
    world: WorldId,
    fact: FactInput,
    schema: WorldSchema,
  ): Promise<Analysis> {
    const asOf = this.today();
    const holds = (f: { retiredAt: string | null; validTo: string | null }): boolean =>
      holding(f, asOf);
    const none: Analysis = { duplicateOf: null, colliding: [] };
    const brief = (f: {
      id: string;
      author: FactAuthor;
      validFrom: string | null;
      validTo: string | null;
    }): Existing => ({
      id: f.id,
      author: f.author,
      validFrom: f.validFrom,
      validTo: f.validTo,
    });
    if (fact.kind === 'entity') {
      const lower = fact.name.toLowerCase();
      const find = (r: Facts) =>
        r.entities.find(
          (e) =>
            e.type === fact.type &&
            (e.name.toLowerCase() === lower || e.aliases.some((a) => a.toLowerCase() === lower)),
        );
      const page = await pagedLookup(
        (limit) =>
          provider.query(world, { kind: 'entities', text: fact.name, types: [fact.type], limit }),
        { ceiling: this.deps.lookupCeiling, satisfied: (r) => find(r) !== undefined },
      );
      const dup = find(page.result);
      if (!dup && !page.complete) return { ...none, incomplete: lookupIncomplete('entity') };
      return { duplicateOf: dup?.id ?? null, colliding: [] };
    }
    if (fact.kind === 'attribute') {
      const h = await provider.history(world, fact.entityId);
      const same = h.attributes.filter((a) => holds(a) && a.key === fact.key);
      const equal = same.find((a) => canonicalJson(a.value) === canonicalJson(fact.value));
      if (equal) return { duplicateOf: equal.id, colliding: [] };
      return { duplicateOf: null, colliding: same.map(brief) };
    }
    const spec = Object.hasOwn(schema.edges, fact.type) ? schema.edges[fact.type] : undefined;
    const findDup = (r: Facts) => r.edges.find((e) => holds(e) && e.toId === fact.toId);
    const page = await pagedLookup(
      (limit) =>
        provider.query(world, {
          kind: 'edges',
          fromId: fact.fromId,
          types: [fact.type],
          limit,
        }),
      { ceiling: this.deps.lookupCeiling, satisfied: (r) => findDup(r) !== undefined },
    );
    const dup = findDup(page.result);
    if (dup) return { duplicateOf: dup.id, colliding: [] };
    // Not found and the set is cut short: a live duplicate or owner may be unseen.
    if (!page.complete) return { ...none, incomplete: lookupIncomplete('edge') };
    if (spec?.unique === 'from')
      return { duplicateOf: null, colliding: page.result.edges.filter(holds).map(brief) };
    if (spec?.unique === 'to') {
      const byTo = await pagedLookup(
        (limit) =>
          provider.query(world, { kind: 'edges', toId: fact.toId, types: [fact.type], limit }),
        { ceiling: this.deps.lookupCeiling },
      );
      // Every live colliding edge must be seen: each one is closed or named in the proposal.
      if (!byTo.complete) return { ...none, incomplete: lookupIncomplete('edge') };
      return { duplicateOf: null, colliding: byTo.result.edges.filter(holds).map(brief) };
    }
    return none;
  }

  async closeFact(
    c: Caller,
    world: string | null,
    factId: string,
    validTo: string,
    sourceRef: string,
  ): Promise<WriteOutcome> {
    const refuse = (reason: string): WriteOutcome => allRefused([factId], reason);
    const p = pick(await this.visible(c), world);
    if (!p.ok) return refuse(p.reason);
    const w = p.w;
    if (w.mode === 'read') return refuse(`read_only: world '${label(w)}' is mounted read-only`);
    if (sourceRef.trim() === '') return refuse('vetting: sourceRef is required');
    if (detectSecrets(sourceRef).length > 0)
      return refuse('vetting: looks like a secret; not stored');

    const provider = await this.deps.providers(w.id);
    const found = await provider.getFact(w.id, factId);
    if (!found) return refuse(`not_found: fact ${factId} not found`);
    if (!live(found)) return refuse(`closed: fact ${factId} is already closed or retired`);

    const closer = c.surface === 'feed' ? 'connector' : 'agent';
    const authoritative = AUTHORITATIVE_AUTHORS.includes(found.author); // R2
    if (w.shared || authoritative) {
      const ctx = await this.agentCtx(c, w, '', undefined);
      const r = this.propose(
        w.id,
        'close',
        { factId, validTo, sourceRef, author: closer },
        authoritative ? factId : null,
        ctx,
        `close ${factId} on ${validTo}`,
      );
      return r.kind === 'proposed'
        ? {
            applied: [],
            proposed: [r.id],
            refused: [],
            ...(r.conflict ? { conflicts: [r.conflict] } : {}),
          }
        : refuse(r.kind === 'refused' ? r.reason : 'refused');
    }
    const r = await provider.close(w.id, factId, validTo, sourceRef, closer);
    return r.ok ? { applied: r.ids, proposed: [], refused: [] } : refuse(`${r.code}: ${r.reason}`);
  }

  async requestSchemaChange(
    c: Caller,
    world: string | null,
    change: SchemaChange,
    reason: string,
  ): Promise<SchemaRequestOutcome> {
    const p = pick(await this.visible(c), world);
    if (!p.ok) return { refused: p.reason };
    if (p.w.mode === 'read')
      return { refused: `read_only: world '${label(p.w)}' is mounted read-only` };
    return this.deps.schema.requestChange(p.w, change, c.personalityId, reason);
  }

  // ---- import and export ---------------------------------------------------

  /** Agent import: proposals on a shared world, `agent` facts on the private one, same routing as `writeFacts`. */
  async importBundle(c: Caller, world: string | null, bundle: GraphBundle): Promise<ImportOutcome> {
    return this.agentImport(c, world, bundle, 'import', undefined);
  }

  /**
   * Like `importBundle`, but every fact becomes a proposal, even on the private
   * world. Entities named by a bundle edge that do not exist yet are proposed in
   * the same batch (WorldCaptureRouter, capture.ts, is the caller).
   */
  async proposeBundle(
    c: Caller,
    world: string | null,
    bundle: GraphBundle,
    why: string,
  ): Promise<ImportOutcome> {
    return this.agentImport(c, world, bundle, why, 'propose');
  }

  private async agentImport(
    c: Caller,
    world: string | null,
    bundle: GraphBundle,
    why: string,
    force: 'propose' | undefined,
  ): Promise<ImportOutcome> {
    const p = pick(await this.visible(c), world);
    if (!p.ok || p.w.mode === 'read') {
      const reason = p.ok ? `read_only: world '${label(p.w)}' is mounted read-only` : p.reason;
      return {
        report: { entities: 0, attributes: 0, edges: 0, skipped: [{ line: 0, reason }] },
        applied: 0,
        proposed: 0,
      };
    }
    const ctx = await this.agentCtx(c, p.w, why, force);
    return this.runImport(await this.deps.providers(p.w.id), p.w, bundle, ctx);
  }

  /** Owner import (web-api, CLI): direct, author `import`; collisions are closed. Not on the tool port. */
  async ownerImport(world: WorldId, bundle: GraphBundle, by: string): Promise<ImportOutcome> {
    const ctx = await this.ownerCtx(world, by, 'import');
    return this.runImport(
      await this.deps.providers(world),
      { id: world, shared: world.startsWith('world:') },
      bundle,
      ctx,
    );
  }

  private async runImport(
    provider: WorldGraphProvider,
    target: Target,
    bundle: GraphBundle,
    ctx: PlaceCtx,
  ): Promise<ImportOutcome> {
    const report: ImportReport = { entities: 0, attributes: 0, edges: 0, skipped: [] };
    const real = new Map<string, string>();
    const pending = new Map<string, EntityRef>();
    let applied = 0;
    let proposed = 0;
    let line = 0;

    const run = async (
      fact: FactInput,
      refs: { entityId?: EntityRef; fromId?: EntityRef; toId?: EntityRef },
      count: 'entities' | 'attributes' | 'edges',
    ): Promise<Placement> => {
      line++;
      const r = await this.place(provider, target, fact, ctx, refs);
      if (r.kind === 'applied') {
        applied++;
        report[count]++;
      } else if (r.kind === 'proposed') {
        proposed++;
        report[count]++;
      } else {
        report.skipped.push({ line, reason: r.reason });
      }
      return r;
    };
    const skip = (reason: string) => report.skipped.push({ line: ++line, reason });
    const endpoint = (id: string): { id: string; ref?: EntityRef } | null => {
      const known = real.get(id);
      if (known !== undefined) return { id: known };
      const ref = pending.get(id);
      return ref ? { id, ref } : null;
    };

    for (const e of bundle.entities) {
      if (e.retiredAt !== null || e.mergedInto !== null) continue;
      const r = await run(
        {
          kind: 'entity',
          type: e.type,
          name: e.name,
          aliases: e.aliases,
          sourceRef: e.sourceRef || 'import',
          author: ctx.author,
        },
        {},
        'entities',
      );
      if (r.kind === 'applied' && r.ids[0] !== undefined) real.set(e.id, r.ids[0]);
      else if (r.kind === 'proposed') pending.set(e.id, { type: e.type, name: e.name });
      else if (r.kind === 'refused' && r.existingId) real.set(e.id, r.existingId);
    }
    for (const a of bundle.attributes) {
      if (a.retiredAt !== null) continue;
      if (a.validTo !== null) {
        skip('closed fact: history is not imported');
        continue;
      }
      const ep = endpoint(a.entityId);
      if (!ep) {
        skip(`entity ${a.entityId} is not in the bundle or was not stored`);
        continue;
      }
      await run(
        {
          kind: 'attribute',
          entityId: ep.id,
          key: a.key,
          value: a.value,
          ...(a.validFrom !== null ? { validFrom: a.validFrom } : {}),
          sourceRef: a.sourceRef || 'import',
          author: ctx.author,
          confidence: a.confidence,
        },
        ep.ref ? { entityId: ep.ref } : {},
        'attributes',
      );
    }
    for (const e of bundle.edges) {
      if (e.retiredAt !== null) continue;
      if (e.validTo !== null) {
        skip('closed fact: history is not imported');
        continue;
      }
      const from = endpoint(e.fromId);
      const to = endpoint(e.toId);
      if (!from || !to) {
        skip(`an endpoint of ${e.type} is not in the bundle or was not stored`);
        continue;
      }
      await run(
        {
          kind: 'edge',
          type: e.type,
          fromId: from.id,
          toId: to.id,
          attrs: e.attrs,
          ...(e.validFrom !== null ? { validFrom: e.validFrom } : {}),
          sourceRef: e.sourceRef || 'import',
          author: ctx.author,
          confidence: e.confidence,
        },
        { ...(from.ref ? { fromId: from.ref } : {}), ...(to.ref ? { toId: to.ref } : {}) },
        'edges',
      );
    }
    return { report, applied, proposed };
  }

  /** What the world holds, behind the same visibility check as `query` (see LIMITATIONS). */
  async exportBundle(c: Caller, world: string | null): Promise<GraphBundle> {
    const w = await this.one(c, world);
    return (await this.deps.providers(w.id)).export(w.id);
  }

  // ---- owner surfaces (web-api, CLI): never on WorldToolPort ---------------

  private async ownerCtx(
    world: WorldId,
    by: string,
    author: 'user' | 'import',
    why = '',
  ): Promise<PlaceCtx> {
    const loaded = await this.deps.schema.load(world);
    return {
      actor: 'owner',
      author,
      by,
      sessionId: null,
      why,
      schema: loaded.schema,
      sensitive: loaded.sensitive,
      batchId: () => `b-${randomBytes(6).toString('hex')}`,
    };
  }

  /** Direct write by the owner: author `user` (or `import`), sensitive attributes allowed, replaced facts closed. */
  async ownerWrite(
    world: WorldId,
    facts: FactInput[],
    by: string,
    opts: { author?: 'user' | 'import' } = {},
  ): Promise<WriteOutcome> {
    const ctx = await this.ownerCtx(world, by, opts.author ?? 'user');
    const provider = await this.deps.providers(world);
    const target = { id: world, shared: world.startsWith('world:') };
    const out: WriteOutcome = { applied: [], proposed: [], refused: [] };
    for (const [index, fact] of facts.entries()) {
      const r = await this.place(provider, target, fact, ctx);
      if (r.kind === 'applied') out.applied.push(...r.ids);
      else if (r.kind === 'refused') out.refused.push({ index, reason: r.reason });
    }
    return out;
  }

  /**
   * Replays a pending proposal with its ORIGINAL author and records `by` as
   * `decided_by`. A conflict proposal closes the facts it replaces on
   * `closeDate` (the new fact's validFrom, or else the proposal's date, never
   * earlier than the old fact's validFrom). Each id in `closes` is read with
   * `getFact` before `assert`: missing, retired, or `validTo` already set
   * refuses and leaves the proposal pending. A close that still fails after
   * assert returns the new id plus the refusal and does not decide. Every
   * graph write here carries the proposal's author and sourceRef; the
   * accepting owner appears only as `decided_by`. Pinned by write-routing.test.ts
   * 'accepting a conflict proposal records the proposal author and source as
   * the closer…', 'accept closes a user fact at its validFrom when the
   * proposal fact starts earlier', 'a close that fails after the new fact is
   * asserted leaves the proposal pending', and 'accept refuses before assert
   * when a close target is already closed'.
   */
  async acceptProposal(id: string, by: string): Promise<WriteOutcome> {
    const refuse = (reason: string): WriteOutcome => allRefused([id], reason);
    const row = this.deps.store.get(id);
    if (row?.status !== 'pending') return refuse('not_pending: no pending proposal with that id');
    const provider = await this.deps.providers(row.world);
    const out: WriteOutcome = { applied: [], proposed: [], refused: [] };

    if (row.kind === 'assert') {
      const payload = parseAssertPayload(row.payload);
      if (!payload) return refuse('unreadable proposal payload');
      const fact = await this.resolveRefs(provider, row.world, payload.fact, payload.refs);
      if (typeof fact === 'string') return refuse(fact);
      const targets: Array<{ id: string; validFrom: string | null }> = [];
      for (const old of payload.closes) {
        const existing = await provider.getFact(row.world, old);
        if (!existing) return refuse(`not_found: fact ${old} not found`);
        if (existing.retiredAt !== null || existing.validTo !== null) {
          return refuse(`closed: fact ${old} is already closed or retired`);
        }
        targets.push({ id: old, validFrom: existing.validFrom });
      }
      const r = await provider.assert(row.world, [fact]);
      if (!r.ok) return refuse(`${r.code}: ${r.reason}`);
      out.applied.push(...r.ids);
      const requested =
        (fact.kind === 'entity' ? undefined : fact.validFrom) ?? row.createdAt.slice(0, 10);
      for (const old of targets) {
        const at = closeDate(requested, old.validFrom);
        const closed = await provider.close(row.world, old.id, at, fact.sourceRef, fact.author);
        if (!closed.ok) {
          out.refused.push({
            index: 0,
            reason: `could not close ${old.id}: ${closed.code}: ${closed.reason}`,
          });
          // The new fact is already in `applied`. Leave the proposal pending.
          return out;
        }
        out.closed = [...(out.closed ?? []), old.id];
      }
    } else if (row.kind === 'close') {
      const payload = parseClosePayload(row.payload);
      if (!payload) return refuse('unreadable proposal payload');
      const r = await provider.close(
        row.world,
        payload.factId,
        payload.validTo,
        payload.sourceRef,
        payload.author,
      );
      if (!r.ok) return refuse(`${r.code}: ${r.reason}`);
      out.applied.push(...r.ids);
    } else if (row.kind === 'schema') {
      const change = parseSchemaPayload(row.payload);
      if (!change) return refuse('unreadable proposal payload');
      const r = await this.deps.schema.apply(
        row.world,
        change,
        { kind: 'user', id: by },
        row.summary,
      );
      if (!r.ok) return refuse(r.error);
    } else {
      return refuse(`unsupported: ${row.kind} proposals cannot be accepted here`);
    }
    if (this.deps.store.decide(id, 'accepted', by) === null) {
      this.fail(new Error(`proposal ${id} was decided while it was being applied`));
    }
    return out;
  }

  /** Endpoints named by (type, name) become real ids; a string result is the refusal. */
  private async resolveRefs(
    provider: WorldGraphProvider,
    world: WorldId,
    fact: FactInput,
    refs: { entityId?: EntityRef; fromId?: EntityRef; toId?: EntityRef },
  ): Promise<FactInput | string> {
    let unseen: string | null = null;
    const find = async (ref: EntityRef): Promise<string | null> => {
      const match = (r: Facts) =>
        r.entities.find((e) => e.type === ref.type && e.name === ref.name)?.id ?? null;
      const page = await pagedLookup(
        (limit) =>
          provider.query(world, { kind: 'entities', text: ref.name, types: [ref.type], limit }),
        { ceiling: this.deps.lookupCeiling, satisfied: (r) => match(r) !== null },
      );
      const id = match(page.result);
      if (id === null && !page.complete) unseen = lookupIncomplete('entity');
      return id;
    };
    const need = async (ref: EntityRef | undefined, current: string): Promise<string | null> =>
      ref ? find(ref) : current;
    if (fact.kind === 'attribute') {
      const entityId = await need(refs.entityId, fact.entityId);
      if (unseen !== null) return unseen;
      return entityId === null
        ? `accept ${refs.entityId?.type} "${refs.entityId?.name}" first`
        : { ...fact, entityId };
    }
    if (fact.kind === 'edge') {
      const fromId = await need(refs.fromId, fact.fromId);
      const toId = await need(refs.toId, fact.toId);
      if (unseen !== null) return unseen;
      if (fromId === null) return `accept ${refs.fromId?.type} "${refs.fromId?.name}" first`;
      if (toId === null) return `accept ${refs.toId?.type} "${refs.toId?.name}" first`;
      return { ...fact, fromId, toId };
    }
    return fact;
  }

  /** Rejects a pending proposal and tombstones its payload so it is not proposed again. */
  async rejectProposal(id: string, by: string, reason?: string): Promise<void> {
    if (this.deps.store.decide(id, 'rejected', by, reason) === null) {
      throw new WorldServiceError('not_pending', `no pending proposal ${id}`);
    }
  }

  /** Retires an agent fact and asserts a `user` row with the same content and dates, source `promoted:<id>`. */
  async promoteToUser(world: WorldId, factId: string, by: string): Promise<WriteOutcome> {
    const refuse = (reason: string): WriteOutcome => allRefused([factId], reason);
    const provider = await this.deps.providers(world);
    const found = await provider.getFact(world, factId);
    if (!found) return refuse(`not_found: fact ${factId} not found`);
    if (!live(found)) return refuse(`closed: fact ${factId} is already closed or retired`);
    if (AUTHORITATIVE_AUTHORS.includes(found.author)) return refuse('already_authoritative');
    const sourceRef = `promoted:${factId}`;
    const from = found.validFrom === null ? {} : { validFrom: found.validFrom };
    const input: FactInput =
      'entityId' in found
        ? {
            kind: 'attribute',
            entityId: found.entityId,
            key: found.key,
            value: found.value,
            ...from,
            sourceRef,
            author: 'user',
            confidence: 1,
          }
        : {
            kind: 'edge',
            type: found.type,
            fromId: found.fromId,
            toId: found.toId,
            attrs: found.attrs,
            ...from,
            sourceRef,
            author: 'user',
            confidence: 1,
          };
    const added = await provider.assert(world, [input]);
    if (!added.ok) return refuse(`${added.code}: ${added.reason}`);
    const retired = await provider.retire(world, factId, `promoted by ${by}`, 'user');
    if (!retired.ok) {
      for (const newId of added.ids) await provider.retire(world, newId, sourceRef, 'user');
      return refuse(`${retired.code}: ${retired.reason}`);
    }
    return { applied: added.ids, proposed: [], refused: [] };
  }

  // ---- owner reads (web-api): the operator sees every world, mounted or not ----
  // Reads only; they bypass `visible` on purpose because the operator owns every personality
  // (plan world-model 7.2). Not on `WorldToolPort` (world-port.test.ts 'R13 tool port is narrow').

  /** The facts of one world at `slice`, without a mount check. */
  async ownerQuery(world: WorldId, q: GraphQuery, slice?: TimeSlice): Promise<Facts> {
    return (await this.deps.providers(world)).query(world, q, slice);
  }

  async ownerNeighbours(
    world: WorldId,
    ref: string,
    hops: number,
    slice?: TimeSlice,
  ): Promise<Subgraph> {
    return (await this.deps.providers(world)).neighbours(world, ref, hops, slice);
  }

  async ownerHistory(
    world: WorldId,
    ref: string,
  ): Promise<{ attributes: AttributeFact[]; edges: Edge[] }> {
    return (await this.deps.providers(world)).history(world, ref);
  }

  async ownerChanges(world: WorldId, since: string, limit: number): Promise<ChangeRow[]> {
    return (await this.deps.providers(world)).changes(world, since, limit);
  }

  async ownerExport(world: WorldId): Promise<GraphBundle> {
    return (await this.deps.providers(world)).export(world);
  }

  /** Closes a live fact on `validTo` as the owner (author `user`). */
  async ownerClose(
    world: WorldId,
    factId: string,
    validTo: string,
    by: string,
  ): Promise<WriteOutcome> {
    const refuse = (reason: string): WriteOutcome => allRefused([factId], reason);
    const provider = await this.deps.providers(world);
    const found = await provider.getFact(world, factId);
    if (!found) return refuse(`not_found: fact ${factId} not found`);
    if (!live(found)) return refuse(`closed: fact ${factId} is already closed or retired`);
    const r = await provider.close(world, factId, validTo, `web:${by}`, 'user');
    return r.ok ? { applied: r.ids, proposed: [], refused: [] } : refuse(`${r.code}: ${r.reason}`);
  }

  /** Proposals for the owner's inbox: conflicts first, then newest first. */
  ownerProposals(filter: { world?: WorldId; status?: ProposalRow['status'] }): ProposalRow[] {
    return this.deps.store.list(filter);
  }

  ownerProposal(id: string): ProposalRow | null {
    return this.deps.store.get(id);
  }

  ownerPendingCount(world: WorldId): number {
    return this.deps.store.countProposals(world);
  }

  /** A staged first build and its items, for `worlds.buildPreview`. Null when unknown. */
  ownerBuild(id: string): { build: BuildRow; items: BuildItemRow[] } | null {
    const build = this.deps.store.getBuild(id);
    return build ? { build, items: this.deps.store.listBuildItems(id) } : null;
  }

  /** The only delete. `by` is recorded in the reason: the provider has no actor field. */
  async purge(
    world: WorldId,
    scope: { entityId?: string },
    reason: string,
    by: string,
  ): Promise<{ removed: number }> {
    const provider = await this.deps.providers(world);
    return provider.purge(world, scope, `${reason} (by ${by})`);
  }
}
