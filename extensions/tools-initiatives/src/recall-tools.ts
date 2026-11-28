import type {
  InitiativeRecallPort,
  InitiativeState,
  Tool,
  ToolContext,
  ToolResult,
} from '@ethosagent/types';
import { argsRecord, failed, invalid, refused, reqString } from './args';

const STATES: readonly InitiativeState[] = [
  'active',
  'self_started',
  'paused',
  'review',
  'ended',
  'stopped',
];
const SEARCH_LIMIT_DEFAULT = 10;
const SEARCH_LIMIT_MAX = 25;

/** Ledger content comes from private runs and chats; a shared room gets none of it. */
const SHARED_REFUSAL = 'the initiative ledger is not shown in shared rooms';

/** A chat call carries its personality in the context; without one there is no scope to read. */
const NO_PERSONALITY_REFUSAL = 'no personality in this context; cannot scope the initiative ledger';

function isState(v: unknown): v is InitiativeState {
  return typeof v === 'string' && (STATES as readonly string[]).includes(v);
}

function baseTool(
  name: string,
  description: string,
  schema: Record<string, unknown>,
): Omit<Tool, 'execute'> {
  return {
    name,
    description,
    toolset: 'initiative',
    maxResultChars: 12000,
    capabilities: {},
    // Findings quote web pages the runs read: treat the text as untrusted data.
    outputIsUntrusted: true,
    schema,
  };
}

/**
 * Read-only recall over the ledger, bound to one personality. Every claim is
 * printed with its finding id (`[F-31]`) so the model can cite it (F-31).
 */
export function createInitiativeRecallTools(
  port: InitiativeRecallPort,
  personalityId: string,
  opts: { surface?: 'chat' | 'run' } = {},
): Tool[] {
  // A run is incognito, so its audience resolves 'shared' although it is a private owner
  // turn; only the run registry factory (wiring initiatives.ts) passes surface 'run'.
  // Both surfaces stay scoped to `personalityId`.
  return buildRecallTools(port, () => personalityId, opts.surface === 'run');
}

/**
 * The chat registry holds one set of recall tools for every personality, so the scope comes
 * from `ctx.personalityId` at execute time; a call without one is refused. Shared rooms are
 * refused. The run registry keeps the bound variant above.
 */
export function createChatInitiativeRecallTools(port: InitiativeRecallPort): Tool[] {
  // alwaysInclude like initiative_define: a personality's own toolset must not hide them.
  return buildRecallTools(port, (ctx) => ctx.personalityId, false).map((t) => ({
    ...t,
    alwaysInclude: true,
  }));
}

function buildRecallTools(
  port: InitiativeRecallPort,
  scopeOf: (ctx: ToolContext) => string | undefined,
  isRun: boolean,
): Tool[] {
  const sharedRoom = (ctx: ToolContext): boolean => !isRun && ctx.roomAudience === 'shared';
  const list: Tool = {
    ...baseTool('initiative_list', "List this personality's initiatives, optionally by state.", {
      type: 'object',
      properties: { states: { type: 'array', items: { type: 'string', enum: [...STATES] } } },
    }),
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      if (sharedRoom(ctx)) return refused(SHARED_REFUSAL);
      const personalityId = scopeOf(ctx);
      if (personalityId === undefined) return refused(NO_PERSONALITY_REFUSAL);
      const a = argsRecord(args ?? {});
      if (failed(a)) return a;
      let states: InitiativeState[] | undefined;
      if (a.states !== undefined) {
        if (!Array.isArray(a.states) || !a.states.every(isState)) {
          return invalid(`states must be a list of: ${STATES.join(', ')}`, 'states');
        }
        states = a.states;
      }
      const rows = port.list(states ? { personalityId, states } : { personalityId });
      if (rows.length === 0) return { ok: true, value: 'No initiatives.' };
      return {
        ok: true,
        value: rows.map((r) => `${r.id} (${r.state}, ${r.origin}, v${r.version})`).join('\n'),
      };
    },
  };

  const search: Tool = {
    ...baseTool(
      'initiative_search',
      'Search findings, briefs and explorations in the ledger. Each hit carries its id.',
      {
        type: 'object',
        properties: { query: { type: 'string' }, limit: { type: 'number' } },
        required: ['query'],
      },
    ),
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      if (sharedRoom(ctx)) return refused(SHARED_REFUSAL);
      const personalityId = scopeOf(ctx);
      if (personalityId === undefined) return refused(NO_PERSONALITY_REFUSAL);
      const a = argsRecord(args);
      if (failed(a)) return a;
      const query = reqString(a, 'query');
      if (failed(query)) return query;
      const limit =
        typeof a.limit === 'number' && Number.isInteger(a.limit) && a.limit > 0
          ? Math.min(a.limit, SEARCH_LIMIT_MAX)
          : SEARCH_LIMIT_DEFAULT;
      const hits = port.search(personalityId, query, limit);
      if (hits.length === 0) return { ok: true, value: 'No matches.' };
      return {
        ok: true,
        value: hits.map((h) => `[${h.id}] (${h.kind}) ${h.snippet}`).join('\n'),
      };
    },
  };

  const get: Tool = {
    ...baseTool(
      'initiative_get',
      'Show one initiative: explorations, briefs and findings with their sources and ids.',
      { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    ),
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      if (sharedRoom(ctx)) return refused(SHARED_REFUSAL);
      const personalityId = scopeOf(ctx);
      if (personalityId === undefined) return refused(NO_PERSONALITY_REFUSAL);
      const a = argsRecord(args);
      if (failed(a)) return a;
      const id = reqString(a, 'id');
      if (failed(id)) return id;
      const found = port.get(id);
      if (found === null || found.initiative.personalityId !== personalityId) {
        return invalid(`initiative "${id}" not found`, 'id');
      }
      const ini = found.initiative;
      const out = [`Initiative ${ini.id} (${ini.state}, ${ini.origin}, v${ini.version})`];
      if (found.explorations.length > 0) {
        out.push('', 'Explorations:');
        for (const e of found.explorations) {
          out.push(
            `- ${e.id} (${e.state}) ${e.question} - spent USD ${e.spentUsd} of ${e.budgetUsd}`,
          );
        }
      }
      for (const b of found.briefs) {
        const partial = b.partial ? ', partial' : '';
        out.push('', `Brief ${b.id} for ${b.explorationId} (v${b.version}${partial}):`, b.bodyMd);
        if (b.recommendedOption !== null) out.push(`recommendation: ${b.recommendedOption}`);
      }
      if (found.findings.length > 0) {
        out.push('', 'Findings:');
        for (const f of found.findings) {
          out.push(`- [${f.id}] ${f.claim} (source: ${f.sourceRef}, confidence ${f.confidence})`);
        }
      }
      return { ok: true, value: out.join('\n') };
    },
  };

  return [list, search, get];
}
