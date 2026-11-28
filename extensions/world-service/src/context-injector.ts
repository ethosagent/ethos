// WorldContextInjector (plan world-model Task 4.4): puts the facts about the
// entities the user just named into the dynamic tail of the system prompt.
//
// What pins each guarantee, in `__tests__/`:
//   - R6, a shared or incognito turn never sees an `owner_only` world: the
//     injector reads only through `WorldService.visible/query/neighbours` with
//     the turn's `roomAudience`, so `resolveAccess` (access.ts) decides. Pinned
//     by world-context-injector.test.ts 'R6 shared turn: owner_only world
//     dropped, shareable world used'.
//   - R5, graph context is tail only: priority 5 is below every shipped
//     injector, so its `append` section renders after all of them, and nothing
//     per-turn (clock time, "as of today", turn number) is rendered. Pinned by
//     packages/wiring/src/__tests__/world-context-prefix.test.ts 'R5 graph
//     context is tail only' (a real AgentLoop).
//   - S6, graph text is untrusted: the whole block goes through the injected
//     `sanitize` (AgentSafety.injection.sanitize, bound in wiring). Pinned by
//     world-context-injector.test.ts 'sanitize is applied'.
//   - A dry run injects nothing: 'dry run → shouldInject false'. No mention of
//     any entity injects nothing: 'no mention → null'.
//   - The budget split is proportional to matched-entity count with a floor of
//     400 chars per matched world: `splitBudget` and 'budget split by
//     relevance: 3 matches in acme, 1 in watchlist → acme gets 3/4, watchlist
//     ≥ 400'.
//
// Limitations (no test pins these):
//   - Matching is one FTS name/alias query per word of the user's message
//     (words of 3+ chars, at most MAX_TERMS), merged by entity id; there is no
//     stop-word list, so a common word that prefix-matches an entity name adds
//     that entity.
//   - The 400-char floor can push the block past `maxChars` when many worlds
//     match; `maxChars` budgets the fact lines, not the heading.
//
// Caller: `surface: 'tool'`. `Caller.surface` only changes the author stamped
// on a WRITE (`'feed'` → connector, service.ts); this injector only reads, and
// it reads as the agent does, so it uses the agent's surface.

import type {
  AttributeFact,
  ContextInjector,
  Edge,
  InjectionResult,
  PromptContext,
} from '@ethosagent/types';
import type { ResolvedWorld } from './access';
import type { Caller, TaggedEntity, TaggedFacts, WorldService } from './service';

/** The fixed heading; the block under it is the only thing this injector adds. */
export const WORLD_CONTEXT_HEADING = 'World facts (from mounted worlds; you may cite them):';

/** Chars a world with at least one match always gets (plan step 3). */
export const WORLD_BUDGET_FLOOR = 400;

const MAX_TERMS = 8;
const MIN_TERM_LENGTH = 3;
const MATCHES_PER_TERM = 5;

export interface WorldContextInjectorOptions {
  service: Pick<WorldService, 'visible' | 'query' | 'neighbours'>;
  /** `AgentSafety.injection.sanitize`, bound in wiring (S6). */
  sanitize: (s: string) => string;
  /** `world.contextMaxChars`, default 2400. */
  maxChars: number;
  /** `world.contextHops`, default 2. */
  hops: 1 | 2;
  onError?: (e: unknown) => void;
}

/**
 * A world's share of `maxChars`: proportional to its matched-entity count, at
 * least `WORLD_BUDGET_FLOOR` for a world with a match, 0 for a world with none.
 * Returned in descending share (ties keep input order).
 */
export function splitBudget<T extends { count: number }>(
  worlds: readonly T[],
  maxChars: number,
): Array<T & { share: number }> {
  const matched = worlds.filter((w) => w.count > 0);
  const total = matched.reduce((n, w) => n + w.count, 0);
  return matched
    .map((w) => ({
      ...w,
      share: Math.max(WORLD_BUDGET_FLOOR, Math.floor((maxChars * w.count) / total)),
    }))
    .sort((a, b) => b.share - a.share);
}

/** Words worth an FTS query: 3+ chars, distinct, in message order, capped. */
function termsOf(text: string): string[] {
  const seen = new Set<string>();
  for (const m of text.match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) ?? []) {
    if (m.length < MIN_TERM_LENGTH) continue;
    seen.add(m.toLowerCase());
    if (seen.size >= MAX_TERMS) break;
  }
  return [...seen];
}

function dates(f: { validFrom: string | null; validTo: string | null; sourceRef: string }): string {
  const parts: string[] = [];
  if (f.validFrom !== null) parts.push(`from ${f.validFrom}`);
  if (f.validTo !== null) parts.push(`until ${f.validTo}`);
  parts.push(`source ${f.sourceRef}`);
  return ` (${parts.join('; ')})`;
}

interface Line {
  recordedAt: string;
  id: string;
  text: string;
}

export class WorldContextInjector implements ContextInjector {
  readonly id = 'world-context';
  readonly priority = 5;

  constructor(private readonly opts: WorldContextInjectorOptions) {}

  shouldInject(ctx: PromptContext): boolean {
    return ctx.personalityId !== undefined && ctx.dryRun !== true;
  }

  async inject(ctx: PromptContext): Promise<InjectionResult | null> {
    if (ctx.personalityId === undefined) return null;
    try {
      return await this.build(ctx, ctx.personalityId);
    } catch (e) {
      this.opts.onError?.(e);
      return null;
    }
  }

  private async build(ctx: PromptContext, personalityId: string): Promise<InjectionResult | null> {
    const caller: Caller = {
      personalityId,
      audience: ctx.roomAudience,
      sessionId: ctx.sessionId,
      surface: 'tool',
    };
    const lastUser = [...ctx.history].reverse().find((m) => m.role === 'user');
    const terms = lastUser ? termsOf(lastUser.content) : [];
    if (terms.length === 0) return null;

    const { service } = this.opts;
    const matched: Array<{
      world: ResolvedWorld;
      entities: TaggedEntity[];
      seed: AttributeFact[];
      count: number;
    }> = [];
    for (const world of await service.visible(caller)) {
      const found = new Map<string, TaggedEntity>();
      const seed = new Map<string, AttributeFact>();
      // Independent reads; merged in term order so the result is deterministic.
      const results = await Promise.all(
        terms.map((text) =>
          service.query(caller, world.id, { kind: 'entities', text, limit: MATCHES_PER_TERM }),
        ),
      );
      for (const r of results) {
        for (const e of r.entities) if (!found.has(e.id)) found.set(e.id, e);
        for (const a of r.attributes) seed.set(a.id, a);
      }
      if (found.size > 0) {
        matched.push({
          world,
          entities: [...found.values()],
          seed: [...seed.values()],
          count: found.size,
        });
      }
    }
    if (matched.length === 0) return null;

    // Descending share; what a short world leaves unused flows to the next.
    const blocks: string[] = [];
    let carry = 0;
    for (const m of splitBudget(matched, this.opts.maxChars)) {
      const budget = m.share + carry;
      const block = await this.renderWorld(caller, m.world, m.entities, m.seed, budget);
      carry = budget - block.length;
      if (block !== '') blocks.push(block);
    }
    if (blocks.length === 0) return null;

    const content = this.opts.sanitize(`${WORLD_CONTEXT_HEADING}\n${blocks.join('\n')}`);
    return { content, position: 'append' };
  }

  /** One line per live fact in the matches' neighbourhoods, newest first, cut at `budget` chars. */
  private async renderWorld(
    caller: Caller,
    world: ResolvedWorld,
    entities: readonly TaggedEntity[],
    seed: readonly AttributeFact[],
    budget: number,
  ): Promise<string> {
    const names = new Map<string, string>(entities.map((e) => [e.id, e.displayTag]));
    // The entity query already returned each match's own live attributes.
    const attrs = new Map<string, AttributeFact>(seed.map((a) => [a.id, a]));
    const edges = new Map<string, Edge>();
    const take = (f: TaggedFacts): void => {
      for (const e of f.entities) names.set(e.id, e.displayTag);
      for (const a of f.attributes) attrs.set(a.id, a);
      for (const e of f.edges) edges.set(e.id, e);
    };
    const hoods = await Promise.all(
      entities.map((e) => this.opts.service.neighbours(caller, world.id, e.id, this.opts.hops)),
    );
    for (const f of hoods) take(f);

    const name = (id: string): string => names.get(id) ?? id;
    const lines: Line[] = [
      ...[...attrs.values()].map((a) => ({
        recordedAt: a.recordedAt,
        id: a.id,
        text: `- ${name(a.entityId)}.${a.key} = ${JSON.stringify(a.value) ?? 'null'}${dates(a)}`,
      })),
      ...[...edges.values()].map((e) => ({
        recordedAt: e.recordedAt,
        id: e.id,
        text: `- ${name(e.fromId)} -${e.type}-> ${name(e.toId)}${dates(e)}`,
      })),
    ].sort((a, b) => b.recordedAt.localeCompare(a.recordedAt) || b.id.localeCompare(a.id));

    let out = '';
    for (const l of lines) {
      const next = out === '' ? l.text : `${out}\n${l.text}`;
      if (next.length > budget) break;
      out = next;
    }
    return out;
  }
}
