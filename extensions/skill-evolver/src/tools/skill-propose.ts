import { join } from 'node:path';
import type { Tool, ToolContext, ToolResult } from '@ethosagent/types';
import type { LearningSubmitPort } from '../learning-port';
import { liveSkillDir } from '../skill-dir';

/**
 * `targetFile` is an LLM tool argument that ends up in three places a loose
 * value would damage: the candidate id (`rewrite-<x>-<ts>`), the generated
 * frontmatter (`name:` and `target_file:`, unquoted YAML), and the destination
 * path. A path-separator check alone let through spaces, `;`, `$(…)`, quotes and
 * newlines. Same class as `analyze.ts`'s filename guard, with the extension
 * optional because the id builder strips a trailing `.md`.
 */
const TARGET_FILE_RE = /^[a-zA-Z0-9_-]+(\.md)?$/;

interface SkillProposeArgs {
  content: string;
  reason: string;
  targetFile?: string;
}

/** Whose skill this is and where it would live. */
export interface SkillProposeTarget {
  personalityId: string;
  /** The personality's `skill_evolution.scope`, read at submit time. */
  scope: 'personality' | 'shared' | undefined;
  /**
   * The personality's `skill_evolution.evolve_existing`, read at submit time.
   * `false` refuses a `targetFile` rewrite; a new skill is still accepted.
   * Absent = rewrites allowed.
   */
  evolveExisting?: boolean;
}

export interface SkillProposeToolOptions {
  /** The learning inbox (`learningSubmitPort` in `packages/wiring/src/learning-pipeline.ts`). */
  learning: LearningSubmitPort;
  /** `~/.ethos` — the root `liveSkillDir` resolves the destination under. */
  dataDir: string;
  /** Path 1 (the post-turn fork) or path 6 (chat). */
  origin: 'fork' | 'chat';
  /** Null refuses the call: a candidate with no personality has no destination. */
  target(ctx: ToolContext): SkillProposeTarget | null;
  /**
   * Freeze the triggering turn as a target case and return its id. A failure
   * here does not block the proposal — a candidate with no target case replays
   * `incomplete` and waits for a human, which is the safe direction.
   */
  targetCaseIds?(ctx: ToolContext, personalityId: string): Promise<string[]>;
  /** Session ids the proposal was drawn from. Defaults to the calling session. */
  evidenceSessionIds?(ctx: ToolContext): string[];
  now?: () => number;
  onProposed?: (candidateId: string, personalityId: string) => void;
  toolset?: string;
}

export function createSkillProposeTool(opts: SkillProposeToolOptions): Tool<SkillProposeArgs> {
  const now = opts.now ?? (() => Date.now());

  return {
    name: 'skill_propose',
    description:
      'Propose a new skill or a rewrite of an existing skill. The proposal goes to the Learning inbox, where it is replayed against past tasks and goes live only on a passing replay or a human approval.',
    toolset: opts.toolset ?? 'skill_evolution',
    capabilities: {},
    schema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Full markdown body of the proposed skill' },
        reason: {
          type: 'string',
          description: 'One sentence explaining why this skill is worth proposing',
        },
        targetFile: {
          type: 'string',
          description: 'Existing skill filename to rewrite. Omit for a new skill.',
        },
      },
      required: ['content', 'reason'],
    },
    async execute(args: SkillProposeArgs, ctx: ToolContext): Promise<ToolResult> {
      if (args.targetFile && !TARGET_FILE_RE.test(args.targetFile)) {
        return {
          ok: false,
          error:
            'Invalid targetFile: use a plain skill filename (letters, digits, `_`, `-`, optional `.md`)',
          code: 'input_invalid',
        };
      }
      const target = opts.target(ctx);
      if (!target) {
        return {
          ok: false,
          error: 'No personality is bound to this turn, so a proposed skill has no destination.',
          code: 'not_available',
        };
      }

      if (args.targetFile && target.evolveExisting === false) {
        return {
          ok: false,
          error:
            'This personality does not rewrite existing skills (skill_evolution.evolve_existing: false). Omit targetFile to propose a new skill.',
          code: 'not_available',
        };
      }

      const ts = now();
      const suffix = Math.random().toString(36).slice(2, 8);
      const targetName = args.targetFile?.replace(/\.md$/, '');
      const id = targetName ? `rewrite-${targetName}-${ts}` : `new-${ts}-${suffix}`;

      const header = [
        '---',
        `name: ${id}`,
        `description: "${args.reason.replace(/["\\]/g, '\\$&').replace(/\n/g, ' ')}"`,
        'ethos:',
        '  evolution:',
        '    auto_proposed: true',
        ...(args.targetFile ? [`    target_file: ${args.targetFile}`] : []),
        '---',
        '',
      ].join('\n');

      // A rewrite lands on the file it names — `promote()` re-derives the same
      // path from `target_file` — not on a new `rewrite-<x>-<ts>.md` beside it.
      const dir = liveSkillDir(opts.dataDir, target.personalityId, target.scope);
      const destination = join(dir, targetName ? `${targetName}.md` : `${id}.md`);

      let targetCaseIds: string[] = [];
      try {
        targetCaseIds = (await opts.targetCaseIds?.(ctx, target.personalityId)) ?? [];
      } catch {
        targetCaseIds = [];
      }

      const candidate = await opts.learning.submit({
        kind: 'skill',
        op: targetName ? 'rewrite' : 'create',
        personalityId: target.personalityId,
        origin: opts.origin,
        destination,
        content: header + args.content,
        evidence: {
          sessionIds: opts.evidenceSessionIds?.(ctx) ?? [ctx.sessionId],
          digest: args.reason,
          ref: `${opts.origin}:${id}`,
        },
        targetCaseIds,
      });
      opts.onProposed?.(candidate.id, target.personalityId);
      return {
        ok: true,
        value: `Skill candidate "${candidate.id}" is waiting in the Learning inbox. It goes live only after a passing replay or a human approval.`,
      };
    },
  };
}
