import type {
  GuidanceMapping,
  InitiativeConfigPort,
  InitiativeLedgerPort,
  InitiativeRecallPort,
  Tool,
  ToolContext,
  ToolResult,
} from '@ethosagent/types';
import {
  argsRecord,
  failed,
  invalid,
  isRecord,
  optString,
  refused,
  reqString,
  stringList,
} from './args';

const OPS = ['create', 'update', 'pause', 'resume', 'end'] as const;
type Op = (typeof OPS)[number];

/** Keys whose change spends money or widens reach: never saved without the owner's yes (O-2). */
const REACH_KEYS = ['budget', 'sources', 'autonomy'] as const;

const SHARED_REFUSAL =
  'initiatives are configured in private chats only; ask the owner in a private conversation';

function isOp(v: unknown): v is Op {
  return typeof v === 'string' && (OPS as readonly string[]).includes(v);
}

function line(label: string, value: unknown): string | null {
  return value === undefined ? null : `${label}: ${JSON.stringify(value)}`;
}

/** What the model shows the owner before asking for a yes. */
function summarise(op: Op, draft: Record<string, unknown>): string {
  const lines = [
    `Proposed ${op} of initiative${typeof draft.id === 'string' ? ` "${draft.id}"` : ''}:`,
    line('title', draft.title),
    line('outcome', draft.outcome),
    line('sources', draft.sources),
    line('budget', draft.budget),
    line('autonomy', draft.autonomy),
    line('timeline', draft.timeline),
    line('guidance', draft.guidance),
  ];
  return lines.filter((l): l is string => l !== null).join('\n');
}

function mappingLine(m: GuidanceMapping): string {
  const note = m.reason === undefined ? '' : ` (${m.reason})`;
  if (m.status === 'mapped') return `- ${m.text} → ${m.mapsTo.join(', ')}${note}`;
  return `- ${m.text} → ${m.status}${note}`;
}

type SaveOk = Extract<Awaited<ReturnType<InitiativeConfigPort['save']>>, { ok: true }>;

function savedCard(op: Op, r: SaveOk): string {
  const out = [`Saved (${op}): initiative "${r.id}", version ${r.version}.`];
  if (r.clamps.length > 0) out.push('Limits applied:', ...r.clamps.map((c) => `- ${c}`));
  if (r.guidance.length > 0) out.push('Guidance:', ...r.guidance.map(mappingLine));
  if (r.nextSurveyAt !== undefined) out.push(`Next survey: ${r.nextSurveyAt}`);
  return out.join('\n');
}

function createDefineTool(config: InitiativeConfigPort): Tool {
  return {
    name: 'initiative_define',
    description:
      'Create or change an initiative (a standing research brief the owner has agreed to) after interviewing the owner. ' +
      'Show the owner the summary and set confirmed:true only after their explicit yes. Creating, and any change to budget, ' +
      'sources or autonomy, is refused until confirmed. pause, resume and end take draft.id. Private chats only.',
    toolset: 'initiative',
    maxResultChars: 4000,
    capabilities: {},
    alwaysInclude: true,
    schema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: [...OPS] },
        id: { type: 'string', description: 'Initiative id (also accepted as draft.id).' },
        draft: {
          type: 'object',
          description: 'The initiative document (create/update) or { id } (pause, resume, end).',
        },
        confirmed: {
          type: 'boolean',
          description: 'True only after the owner said yes to the summary.',
        },
      },
      required: ['op', 'confirmed'],
    },
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      if (ctx.roomAudience === 'shared') return refused(SHARED_REFUSAL);
      if (ctx.personalityId === undefined) return refused('no personality in this turn');
      const a = argsRecord(args);
      if (failed(a)) return a;
      if (!isOp(a.op)) return invalid(`op must be one of ${OPS.join(', ')}`, 'op');
      if (typeof a.confirmed !== 'boolean')
        return invalid('confirmed must be a boolean', 'confirmed');
      const id = optString(a, 'id');
      if (failed(id)) return id;
      const base = isRecord(a.draft) ? a.draft : a.draft === undefined ? {} : null;
      if (base === null) return invalid('draft must be an object', 'draft');
      const draft = id !== undefined && base.id === undefined ? { ...base, id } : base;

      const op = a.op;
      const reach = op === 'update' && REACH_KEYS.some((k) => draft[k] !== undefined);
      if (!a.confirmed && (op === 'create' || reach)) {
        return refused(
          `Not saved: the owner has not confirmed. Show them this and ask for a yes, then call again with confirmed:true.\n${summarise(op, draft)}`,
        );
      }

      const result = await config.save({
        personalityId: ctx.personalityId,
        op,
        draft,
        sessionId: ctx.sessionId,
        confirmedBy: 'owner_chat',
      });
      if (!result.ok) return { ok: false, code: 'input_invalid', error: result.error };
      return { ok: true, value: savedCard(op, result) };
    },
  };
}

function createAddIdeasTool(
  ideas: (pid: string) => InitiativeLedgerPort,
  recall: Pick<InitiativeRecallPort, 'list'>,
): Tool {
  return {
    name: 'initiative_add_ideas',
    description:
      'Record ideas (and optional standing guidance notes) the owner gave for an initiative. They land in the ledger as ' +
      "the owner's own ideas. Private chats only.",
    toolset: 'initiative',
    maxResultChars: 2000,
    capabilities: {},
    alwaysInclude: true,
    schema: {
      type: 'object',
      properties: {
        initiative_id: { type: 'string' },
        ideas: { type: 'array', items: { type: 'string' } },
        guidance: { type: 'array', items: { type: 'string' } },
      },
      required: ['initiative_id', 'ideas'],
    },
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      if (ctx.roomAudience === 'shared') return refused(SHARED_REFUSAL);
      if (ctx.personalityId === undefined) return refused('no personality in this turn');
      const a = argsRecord(args);
      if (failed(a)) return a;
      const initiativeId = reqString(a, 'initiative_id');
      if (failed(initiativeId)) return initiativeId;
      const list = stringList(a, 'ideas');
      if (failed(list)) return list;
      const guidance = a.guidance === undefined ? [] : stringList(a, 'guidance');
      if (failed(guidance)) return guidance;

      // An idea may only land on an initiative this personality owns.
      const owned = recall.list({ personalityId: ctx.personalityId });
      if (!owned.some((r) => r.id === initiativeId)) {
        return refused(`initiative "${initiativeId}" not found for this personality`);
      }
      const port = ideas(ctx.personalityId);
      try {
        for (const text of list) {
          port.addIdea({ initiativeId, origin: 'human', text, sourceRef: null });
        }
        // Guidance is not written to the YAML here (only initiative_define does that);
        // it is kept as owner notes the next define/update can fold in.
        for (const text of guidance) {
          port.addIdea({ initiativeId, origin: 'human', text, sourceRef: 'owner_guidance' });
        }
      } catch (err) {
        return {
          ok: false,
          code: 'execution_failed',
          error: err instanceof Error ? err.message : 'could not record ideas',
          cause: err,
        };
      }
      const g = guidance.length > 0 ? ` and ${guidance.length} guidance note(s)` : '';
      return { ok: true, value: `Recorded ${list.length} idea(s)${g} for "${initiativeId}".` };
    },
  };
}

/** Chat-only tools: the owner defines initiatives and feeds ideas. Never part of a run. */
export function createInitiativeChatTools(deps: {
  config: InitiativeConfigPort;
  ideas: (pid: string) => InitiativeLedgerPort;
  /** Looks the initiative up for ownership (`list` for ctx.personalityId). */
  recall: Pick<InitiativeRecallPort, 'list'>;
}): Tool[] {
  return [createDefineTool(deps.config), createAddIdeasTool(deps.ideas, deps.recall)];
}
