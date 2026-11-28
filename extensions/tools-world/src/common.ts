// Shared by the ten world_* tools: who is calling, how a world is named, and
// how a result is written so every line carries its world tag (R8).

import type { Tool, ToolContext, ToolResult, TurnAudience } from '@ethosagent/types';
import {
  type Caller,
  type TaggedFacts,
  type WorldReadPort,
  WorldServiceError,
} from '@ethosagent/world-service';

export type ToolDef = Tool<Record<string, unknown>>;

export const WORLD_PROP = {
  type: 'string',
  description:
    'World to use: a mount name, a world slug, or "private" for your own. Omit to span every visible world (reads) or when only one world is visible (writes).',
} as const;

export const fail = (
  code: 'input_invalid' | 'not_available' | 'execution_failed',
  error: string,
): ToolResult => ({ ok: false, code, error });

/** The caller the service sees. `null` when the turn names no personality. */
export function callerOf(ctx: ToolContext): Caller | null {
  if (!ctx.personalityId) return null;
  return {
    personalityId: ctx.personalityId,
    audience: ctx.roomAudience,
    sessionId: ctx.sessionId,
    surface: 'tool',
  };
}

export const NO_PERSONALITY: ToolResult = fail(
  'not_available',
  'World tools need an active personality on this turn.',
);

/** Same rule `WorldService` applies: only an explicitly private turn is private. */
export const isSharedTurn = (audience: TurnAudience | undefined): boolean => audience !== 'private';

/** Service refusals (`WORLD_REQUIRED`, `not_mounted`) become a tool error; anything else is rethrown. */
export function serviceError(e: unknown): ToolResult {
  if (e instanceof WorldServiceError) return fail('input_invalid', e.message);
  throw e;
}

/** The label the service tags results with: the mount alias when set, else the slug. */
export async function resolveWorld(
  port: WorldReadPort,
  caller: Caller,
  world: string | undefined,
): Promise<
  | { ok: true; id: `world:${string}` | `personality:${string}`; label: string }
  | { ok: false; error: string }
> {
  const visible = await port.visible(caller);
  const names = visible.map((w) => w.alias ?? w.tag);
  const hit =
    world === undefined
      ? visible.length === 1
        ? visible[0]
        : undefined
      : visible.find((w) => w.alias === world || w.tag === world || w.id === world);
  if (hit) return { ok: true, id: hit.id, label: hit.alias ?? hit.tag };
  if (world === undefined && visible.length > 1) {
    return { ok: false, error: `WORLD_REQUIRED: name a world; visible: ${names.join(', ')}` };
  }
  return {
    ok: false,
    error: `not_mounted: ${world === undefined ? 'no world is visible to this turn' : `'${world}' is not visible to this turn`} (visible: ${names.join(', ') || 'none'})`,
  };
}

const authorLabel = { user: 'you', import: 'import', connector: 'feed', agent: 'agent' } as const;

const day = (iso: string | null): string | null => (iso ? iso.slice(0, 10) : null);

function span(validFrom: string | null, validTo: string | null): string {
  const from = day(validFrom);
  const to = day(validTo);
  return `${from ? ` since ${from}` : ''}${to ? ` until ${to}` : ''}`;
}

/**
 * One line per fact, each starting with its world tag: `acme:Ravi (Person)
 * owns billing-svc (Service) since 2026-11-20 · source chat:s-41 · you`.
 * Entities and facts carry `#id` so a later call can name them. An empty result
 * says which worlds were searched (R8 pinned by world-tools.test.ts).
 */
export function formatFacts(facts: TaggedFacts): string[] {
  const byId = new Map<string, { name: string; type: string; tag: string }>();
  for (const e of facts.entities) byId.set(e.id, { name: e.name, type: e.type, tag: e.tag });
  const ref = (tag: string, id: string): string => {
    const e = byId.get(id);
    return e ? `${e.name} (${e.type})` : `${tag}:${id}`;
  };
  const lines: string[] = [];
  for (const e of facts.entities) {
    lines.push(
      `${e.displayTag} (${e.type}) · source ${e.sourceRef} · ${authorLabel[e.author]} · #${e.id}`,
    );
  }
  for (const a of facts.attributes) {
    const owner = byId.get(a.entityId);
    const who = owner ? `${a.tag}:${owner.name}` : `${a.tag}:${a.entityId}`;
    const conf = a.confidence < 1 ? ` · confidence ${a.confidence}` : '';
    lines.push(
      `${who}.${a.key} = ${JSON.stringify(a.value)}${span(a.validFrom, a.validTo)} · source ${a.sourceRef} · ${authorLabel[a.author]}${conf} · #${a.id}`,
    );
  }
  for (const r of facts.edges) {
    const from = byId.get(r.fromId);
    const lead = from ? `${r.tag}:${from.name} (${from.type})` : `${r.tag}:${r.fromId}`;
    const conf = r.confidence < 1 ? ` · confidence ${r.confidence}` : '';
    lines.push(
      `${lead} ${r.type} ${ref(r.tag, r.toId)}${span(r.validFrom, r.validTo)} · source ${r.sourceRef} · ${authorLabel[r.author]}${conf} · #${r.id}`,
    );
  }
  for (const p of facts.paths ?? []) {
    lines.push(`path: ${p.map((id) => byId.get(id)?.name ?? id).join(' -> ')}`);
  }
  return lines;
}

/** The result text of a read: lines, a truncation note, or a line naming the worlds searched. */
export async function readResult(
  port: WorldReadPort,
  caller: Caller,
  facts: TaggedFacts,
): Promise<ToolResult> {
  const lines = formatFacts(facts);
  if (lines.length === 0) {
    const names = (await port.visible(caller)).map((w) => w.alias ?? w.tag);
    return {
      ok: true,
      value: `No matching facts in worlds: ${names.join(', ') || 'none visible'}.`,
    };
  }
  if (facts.truncated) lines.push('(more results exist; narrow the query)');
  return { ok: true, value: lines.join('\n') };
}

export const AS_OF = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/;
