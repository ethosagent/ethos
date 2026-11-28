// WorldCaptureRouter: the world-graph half of the `routeFact` seam in
// extensions/memory-capture (plan world-model Task 6.1). One extraction pass
// finds durable facts; a fact that reads as `subject --relation--> object` is
// offered here, and goes to the graph (as a PROPOSAL) only when a world the
// personality may write or propose to has an entity type for each end and an
// edge type for the relation. Otherwise it stays in memory, so a fact is never
// dropped and never written to both.
//
// memory-capture is not imported: the seam is structural (`CapturedFact`,
// `CaptureJobRef` below match its `CaptureFact` / `CaptureJob`).
//
// What pins each guarantee, all in `__tests__/world-capture.test.ts`:
// - 'graph fact is proposed, never applied, even on the private world':
//   `WorldService.proposeBundle` forces a proposal.
// - 'fact for a read-only mount is kept in memory, not dropped': only worlds in
//   mode write or propose are considered.
// - 'R10 the router asks for a private audience only': the Caller always carries
//   audience 'private' (memory-capture's `evaluateEligibility` refuses shared and
//   incognito turns first, `shared-audience`, so none reach the router), and
//   `resolveAccess` drops owner_only worlds for any other audience.

import type { Edge, Entity, GraphBundle, WorldSchema } from '@ethosagent/types';
import type { ResolvedWorld } from './access';
import type { WorldSchemaService } from './schema-service';
import type { Caller, WorldService } from './service';

/** Structural twin of memory-capture's `CaptureFact`. */
export interface CapturedFact {
  text: string;
  hint: number;
  triple?: { subject: string; relation: string; object: string };
}

/** Structural twin of the fields of memory-capture's `CaptureJob` used here. */
export interface CaptureJobRef {
  sessionId: string;
  personalityId: string;
  initialPrompt: string;
}

export interface WorldCaptureRouterDeps {
  service: WorldService;
  schema: WorldSchemaService;
  onError?: (e: unknown) => void;
}

const LOOKUP_LIMIT = 50;
const SOURCE_PROMPT_CHARS = 160;

const norm = (s: string): string =>
  s
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');

export class WorldCaptureRouter {
  private readonly deps: WorldCaptureRouterDeps;

  constructor(deps: WorldCaptureRouterDeps) {
    this.deps = deps;
  }

  /** The `routeFact` callback: `'graph'` when a proposal was queued (or already is), else `'memory'`. */
  async route(fact: CapturedFact, job: CaptureJobRef): Promise<'memory' | 'graph'> {
    const triple = fact.triple;
    if (!triple) return 'memory';
    const caller: Caller = {
      personalityId: job.personalityId,
      audience: 'private',
      sessionId: job.sessionId,
      surface: 'extraction',
    };
    try {
      for (const w of await this.deps.service.visible(caller)) {
        if (w.mode === 'read') continue; // kept in memory, not dropped
        const bundle = await this.map(caller, w, fact, triple, job);
        if (!bundle) continue;
        const out = await this.deps.service.proposeBundle(
          caller,
          w.alias ?? w.tag,
          bundle.bundle,
          `extracted from session ${job.sessionId}`,
        );
        if (out.report.edges > 0) return 'graph';
        // An edge already stored (or already proposed) is placed: not memory's job either.
        const edgeSkip = out.report.skipped.find((s) => s.line === bundle.edgeLine);
        if (edgeSkip?.reason.startsWith('duplicate')) return 'graph';
      }
    } catch (err) {
      this.deps.onError?.(err);
    }
    return 'memory';
  }

  /** The bundle that states the triple in world `w`, or null when `w`'s schema cannot hold it. */
  private async map(
    caller: Caller,
    w: ResolvedWorld,
    fact: CapturedFact,
    triple: NonNullable<CapturedFact['triple']>,
    job: CaptureJobRef,
  ): Promise<{ bundle: GraphBundle; edgeLine: number } | null> {
    const { schema } = await this.deps.schema.load(w.id);
    const relation = Object.keys(schema.edges).find((k) => norm(k) === norm(triple.relation));
    if (relation === undefined) return null;
    const spec = schema.edges[relation];
    if (!spec) return null;
    const from = await this.endpoint(caller, w, schema, triple.subject, spec.from);
    const to = await this.endpoint(caller, w, schema, triple.object, spec.to);
    if (!from || !to) return null;

    const sourceRef = `session:${job.sessionId} ${job.initialPrompt.slice(0, SOURCE_PROMPT_CHARS)}`;
    const at = new Date(0).toISOString();
    const entity = (id: string, type: string, name: string): Entity => ({
      id,
      world: w.id,
      type,
      name,
      aliases: [],
      recordedAt: at,
      retiredAt: null,
      sourceRef,
      author: 'agent',
      mergedInto: null,
    });
    const edge: Edge = {
      id: 'capture-edge',
      world: w.id,
      type: relation,
      fromId: 'capture-from',
      toId: 'capture-to',
      attrs: {},
      validFrom: null,
      validTo: null,
      recordedAt: at,
      retiredAt: null,
      sourceRef,
      author: 'agent',
      confidence: fact.hint,
    };
    const entities = [
      entity('capture-from', from.type, from.name),
      entity('capture-to', to.type, to.name),
    ];
    return {
      bundle: { schema: null, entities, attributes: [], edges: [edge] },
      edgeLine: entities.length + 1,
    };
  }

  /**
   * The entity an end of the triple names: an existing one (its own type must be
   * allowed by the edge) or, when none exists, a new one of the edge's only
   * allowed type. Two plausible types and no existing entity is ambiguous: null.
   */
  private async endpoint(
    caller: Caller,
    w: ResolvedWorld,
    schema: WorldSchema,
    name: string,
    allowed: readonly string[],
  ): Promise<{ type: string; name: string } | null> {
    const wanted = name.trim();
    const lower = wanted.toLowerCase();
    const found = await this.deps.service.query(caller, w.alias ?? w.tag, {
      kind: 'entities',
      text: wanted,
      limit: LOOKUP_LIMIT,
    });
    const same = found.entities.filter(
      (e) => e.name.toLowerCase() === lower || e.aliases.some((a) => a.toLowerCase() === lower),
    );
    if (same.length > 0) {
      const fits = same.filter((e) => allowed.includes(e.type));
      const types = new Set(fits.map((e) => e.type));
      const only = fits[0];
      return types.size === 1 && only ? { type: only.type, name: only.name } : null;
    }
    const [type, ...rest] = allowed.filter((t) => Object.hasOwn(schema.entities, t));
    return type !== undefined && rest.length === 0 ? { type, name: wanted } : null;
  }
}
