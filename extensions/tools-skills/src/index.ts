import { assertSafeId, type Tool, type ToolResult } from '@ethosagent/types';

export interface SkillEntry {
  name: string;
  description: string;
  kind?: string;
}

/** One skill candidate waiting in the learning inbox. `id` is the candidate id. */
export interface PendingSkillSummary {
  id: string;
  name: string;
  description: string | null;
  body: string;
  proposedAt: string;
}

/**
 * The waiting-skill slice of the learning inbox, declared structurally so this
 * package keeps its single `@ethosagent/types` dependency. The composition root
 * passes `learningPendingSkillsPort` (`packages/wiring/src/learning-pipeline.ts`),
 * which lists and rejects through `LearningInbox` — the same object the
 * `learning.*` RPCs and `ethos learning` decide through, not a second path.
 *
 * There is no `approvePending` here on purpose: approval is human-only (L-D13,
 * see `skills_pending_approve` below), so no tool in this package can promote.
 */
export interface PendingSkillsPort {
  listPending(): Promise<PendingSkillSummary[]>;
  rejectPending(id: string): Promise<void>;
}

/**
 * What `skills_pending_approve` answers, every time. Names both human paths.
 * `ethos learning approve` is `apps/ethos/src/commands/learning.ts` (L-T8).
 */
export const SKILL_APPROVAL_IS_HUMAN_ONLY =
  'Approving a proposed skill is a human decision and cannot be made from chat. ' +
  'Ask the user to run `ethos learning approve <id>` in a terminal (adding ' +
  '`--override "<reason>"` when it has not passed a replay), or to approve it ' +
  'from the Skills page approval queue in the web UI, which asks for a reason when one is needed. ' +
  'Rejecting still works here, with skills_pending_reject.';

export interface SkillsToolsOptions {
  listSkills: (personalityId?: string) => SkillEntry[];
  getSkillContent: (name: string, personalityId?: string) => string | null;
  pending: PendingSkillsPort;
}

/**
 * `SkillsLibrary` validates every id it joins into a path. Mirror that guard
 * here so a bad id becomes a typed tool error instead of a thrown
 * `IdValidationError` — and so `skills_pending_view`, which reads the queue
 * rather than calling a validating library method, is guarded too.
 */
function isSafeSkillId(id: string): boolean {
  try {
    assertSafeId(id, 'skillId');
    return true;
  } catch {
    return false;
  }
}

function invalidId(id: string): ToolResult {
  return {
    ok: false,
    code: 'input_invalid',
    error: `Invalid pending skill id "${id}". Use skills_pending_list to get exact ids.`,
    field: 'id',
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createSkillsTools(opts: SkillsToolsOptions): Tool[] {
  const skillsListTool: Tool = {
    name: 'skills_list',
    description:
      'List all available skills the current personality has access to. Returns name, description, and kind for each.',
    toolset: 'skills',
    maxResultChars: 10_000,
    capabilities: {},
    schema: { type: 'object', properties: {}, required: [] },
    async execute(_, ctx): Promise<ToolResult> {
      const skills = opts.listSkills(ctx.personalityId);
      if (skills.length === 0) {
        return { ok: true, value: 'No skills available for this personality.' };
      }
      const formatted = skills
        .map((s) => `- **${s.name}**${s.kind ? ` [${s.kind}]` : ''}: ${s.description}`)
        .join('\n');
      return { ok: true, value: `${skills.length} skills available:\n\n${formatted}` };
    },
  };

  const skillViewTool: Tool = {
    name: 'skill_view',
    description:
      'View the full content of a skill by name. Use skills_list first to discover available skills.',
    toolset: 'skills',
    maxResultChars: 30_000,
    capabilities: {},
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the skill to view' },
      },
      required: ['name'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      const { name } = args as { name: string };
      if (!name) return { ok: false, error: 'name is required', code: 'input_invalid' };

      const content = opts.getSkillContent(name, ctx.personalityId);
      if (content === null) {
        return {
          ok: false,
          error: `Skill "${name}" not found or not accessible.`,
          code: 'not_available',
        };
      }
      return { ok: true, value: content };
    },
  };

  // ---------------------------------------------------------------------------
  // Pending-queue review, from chat. Listing, viewing and rejecting work here;
  // approving does not (L-D13).
  // ---------------------------------------------------------------------------

  const pendingListTool: Tool = {
    name: 'skills_pending_list',
    description:
      'List proposed skills waiting for the user to approve or reject. Returns id, name, description, and when each was proposed. An empty queue is a normal result, not an error.',
    toolset: 'skills',
    maxResultChars: 10_000,
    capabilities: {},
    schema: { type: 'object', properties: {}, required: [] },
    async execute(): Promise<ToolResult> {
      const items = await opts.pending.listPending();
      if (items.length === 0) {
        return { ok: true, value: 'No proposed skills are waiting for review.' };
      }
      const formatted = items
        .map(
          (p) =>
            `- **${p.name}** (id: \`${p.id}\`, proposed ${p.proposedAt})\n  ${p.description ?? 'No description.'}`,
        )
        .join('\n');
      return {
        ok: true,
        value: `${items.length} proposed skill(s) awaiting review:\n\n${formatted}\n\nUse skills_pending_view to read one in full. The user approves with \`ethos learning approve <id>\` or from the Skills page approval queue in the web UI; skills_pending_reject discards one.`,
      };
    },
  };

  const pendingViewTool: Tool = {
    name: 'skills_pending_view',
    description:
      'Show the full body of one proposed skill so the user can judge it before approving or rejecting. Use skills_pending_list first to get the id.',
    toolset: 'skills',
    maxResultChars: 30_000,
    capabilities: {},
    schema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Id of the proposed skill, exactly as returned by skills_pending_list',
        },
      },
      required: ['id'],
    },
    async execute(args): Promise<ToolResult> {
      const { id } = args as { id: string };
      if (!id) return { ok: false, error: 'id is required', code: 'input_invalid', field: 'id' };
      if (!isSafeSkillId(id)) return invalidId(id);

      const match = (await opts.pending.listPending()).find((p) => p.id === id);
      if (!match) {
        return {
          ok: false,
          error: `No proposed skill with id "${id}" is waiting for review.`,
          code: 'not_available',
        };
      }
      const header = [
        `# ${match.name}`,
        `Id: ${match.id}`,
        `Proposed: ${match.proposedAt}`,
        ...(match.description ? [`Description: ${match.description}`] : []),
      ].join('\n');
      return { ok: true, value: `${header}\n\n---\n\n${match.body}` };
    },
  };

  // L-D13 (plan `trust-before-reach.md` Part 4) — approval is human-only, so
  // this tool never promotes. The auto resolver (`replayAndResolve` in
  // `extensions/learning-inbox/src/auto-promotion.ts`) is the ONE non-human
  // promotion path, and it promotes only on a measured `pass`. A model
  // approving its own proposal in chat would be a second one — and on CLI/TUI,
  // where no approval prompt appears, it would promote with no human at all.
  // Rejecting stays, because rejection only narrows what the agent can do.
  const pendingApproveTool: Tool = {
    name: 'skills_pending_approve',
    description:
      'Does not approve. Approving a proposed skill is a human decision made outside chat — with `ethos learning approve <id>` in a terminal, or from the Skills page approval queue in the web UI. Call this only to tell the user how to approve a skill they asked about.',
    toolset: 'skills',
    maxResultChars: 2_000,
    requiresApproval: true,
    capabilities: {},
    schema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description:
            'Id of the proposed skill to approve, exactly as returned by skills_pending_list',
        },
      },
      required: ['id'],
    },
    async execute(): Promise<ToolResult> {
      return { ok: false, code: 'not_available', error: SKILL_APPROVAL_IS_HUMAN_ONLY };
    },
  };

  const pendingRejectTool: Tool = {
    name: 'skills_pending_reject',
    description:
      'Reject one proposed skill by id, discarding it from the review queue. Call this only when the user has explicitly asked for that specific skill to be rejected. The id is shown to the user in the confirmation prompt on surfaces that have one (web, desktop, Slack); in the CLI and TUI there is no approval prompt and this runs immediately.',
    toolset: 'skills',
    maxResultChars: 2_000,
    requiresApproval: true,
    capabilities: {},
    schema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description:
            'Id of the proposed skill to reject, exactly as returned by skills_pending_list',
        },
      },
      required: ['id'],
    },
    async execute(args): Promise<ToolResult> {
      const { id } = args as { id: string };
      if (!id) return { ok: false, error: 'id is required', code: 'input_invalid', field: 'id' };
      if (!isSafeSkillId(id)) return invalidId(id);

      try {
        await opts.pending.rejectPending(id);
      } catch (err) {
        return { ok: false, error: messageOf(err), code: 'not_available' };
      }
      return { ok: true, value: `Rejected proposed skill "${id}". It has been discarded.` };
    },
  };

  return [
    skillsListTool,
    skillViewTool,
    pendingListTool,
    pendingViewTool,
    pendingApproveTool,
    pendingRejectTool,
  ];
}
