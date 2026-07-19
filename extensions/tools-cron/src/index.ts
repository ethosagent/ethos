import type {
  CronJob,
  CronJobUpdate,
  CronRunInfo,
  JobOrigin,
  RepeatPolicy,
  ScriptRef,
} from '@ethosagent/cron';
import { type CronScheduler, isValidSchedule, nextRunForSchedule } from '@ethosagent/cron';
import { shortPatternCheck } from '@ethosagent/safety-injection';
import type { Tool, ToolContext, ToolResult } from '@ethosagent/types';

// ---------------------------------------------------------------------------
// Action enum — single dispatch surface for all cron operations
// ---------------------------------------------------------------------------

type CronAction =
  | 'create'
  | 'list'
  | 'get'
  | 'read_run'
  | 'update'
  | 'pause'
  | 'resume'
  | 'run'
  | 'remove';

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCronTool(scheduler: CronScheduler): Tool[] {
  return [
    {
      name: 'cron',
      description:
        'Manage scheduled recurring tasks. Use the `action` field to create, list, get, read_run, update, pause, resume, run, or remove cron jobs.',
      toolset: 'cron',
      capabilities: {},
      schema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [
              'create',
              'list',
              'get',
              'read_run',
              'update',
              'pause',
              'resume',
              'run',
              'remove',
            ],
            description: 'The cron operation to perform.',
          },
          name: {
            type: 'string',
            description: 'Human-readable name for the job (create).',
          },
          schedule: {
            type: 'string',
            description:
              'Schedule: cron ("0 8 * * 1-5"), relative delay ("30m"), recurring interval ("every 2h"), or ISO timestamp ("2026-06-01T09:00:00Z"). All cron times are local (create, update).',
          },
          prompt: {
            type: 'string',
            description: 'The prompt the agent will run on each execution (create, update).',
          },
          // Script jobs reference operator-authored files in ~/.ethos/scripts/.
          // The LLM can schedule an EXISTING script but cannot author shell —
          // the referenced file must already exist (plan gap-event-triggers §5.1c).
          script_file: {
            type: 'string',
            description:
              'Zero-LLM script job: filename relative to the operator scripts directory (~/.ethos/scripts/). The file must already exist; only .sh (bash) and .py (python3) are allowed. Mutually exclusive with prompt (create, update).',
          },
          timeout_seconds: {
            type: 'number',
            description: 'Script timeout in seconds. Default 60, max 600 (with script_file).',
          },
          precheck_file: {
            type: 'string',
            description:
              'Precheck gate for prompt jobs: script filename relative to ~/.ethos/scripts/ (must already exist; .sh or .py). Runs before the LLM turn — exit 0 injects its stdout as context, exit 78 skips the turn entirely (create, update).',
          },
          precheck_timeout_seconds: {
            type: 'number',
            description: 'Precheck timeout in seconds. Default 60, max 600 (with precheck_file).',
          },
          missed_run_policy: {
            type: 'string',
            enum: ['run-once', 'skip'],
            description:
              '"run-once" runs the missed job on next start. "skip" waits for the next scheduled time. Default: skip (create).',
          },
          context_from: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Job ids/names whose latest output will be prepended as context at run time (optional, create).',
          },
          repeat: {
            type: 'object',
            description:
              'Repeat policy: { kind: "forever" | "once" | "count", maxRuns?: number }. Default: forever for cron/interval, once for delays/timestamps (create).',
            properties: {
              kind: { type: 'string', enum: ['forever', 'once', 'count'] },
              maxRuns: { type: 'number' },
            },
          },
          id: {
            type: 'string',
            description: 'Job id (get, read_run, update, pause, resume, run, remove).',
          },
          at: {
            type: 'string',
            description: 'ISO-8601 timestamp of the run to read (read_run).',
          },
          personalityId: {
            type: 'string',
            description: 'Filter jobs by personality (list).',
          },
        },
        required: ['action'],
      },
      async execute(args, ctx): Promise<ToolResult> {
        const {
          action,
          name,
          schedule,
          prompt,
          script_file,
          timeout_seconds,
          precheck_file,
          precheck_timeout_seconds,
          missed_run_policy,
          context_from,
          repeat,
          id,
          at,
          personalityId,
        } = args as {
          action: CronAction;
          name?: string;
          schedule?: string;
          prompt?: string;
          script_file?: string;
          timeout_seconds?: number;
          precheck_file?: string;
          precheck_timeout_seconds?: number;
          missed_run_policy?: 'run-once' | 'skip';
          context_from?: string[];
          repeat?: RepeatPolicy;
          id?: string;
          at?: string;
          personalityId?: string;
        };

        switch (action) {
          case 'create':
            return handleCreate(scheduler, ctx, {
              name,
              schedule,
              prompt,
              script_file,
              timeout_seconds,
              precheck_file,
              precheck_timeout_seconds,
              missed_run_policy,
              context_from,
              repeat,
            });
          case 'list':
            return handleList(scheduler, { personalityId });
          case 'get':
            return handleGet(scheduler, { id });
          case 'read_run':
            return handleReadRun(scheduler, { id, at });
          case 'update':
            return handleUpdate(scheduler, {
              id,
              name,
              schedule,
              prompt,
              script_file,
              timeout_seconds,
              precheck_file,
              precheck_timeout_seconds,
            });
          case 'pause':
            return handlePause(scheduler, { id });
          case 'resume':
            return handleResume(scheduler, { id });
          case 'run':
            return handleRun(scheduler, { id });
          case 'remove':
            return handleRemove(scheduler, { id });
          default:
            return { ok: false, error: `Unknown action: ${action}`, code: 'input_invalid' };
        }
      },
    },
  ];
}

/** Backward-compat alias so existing `import { createCronTools }` keeps working. */
export const createCronTools = createCronTool;

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

/**
 * Extract a JobOrigin from the tool context when the call originates
 * from a channel adapter. CLI and web contexts return undefined (file-only).
 * Gateway session keys follow `${platform}:${botKey}:${chatId}`.
 */
function extractOrigin(ctx: { platform: string; sessionKey: string }): JobOrigin | undefined {
  if (!ctx.platform || ctx.platform === 'cli') return undefined;
  // Web chat: store the full sessionKey so the cron runner can replay output
  // into the originating chat session.
  if (ctx.platform === 'web') {
    return ctx.sessionKey ? { platform: 'web', chatId: ctx.sessionKey } : undefined;
  }
  // Channel adapters: gateway session keys follow `${platform}:${botKey}:${chatId}`.
  const parts = ctx.sessionKey.split(':');
  if (parts.length >= 3) {
    const chatId = parts[2];
    if (chatId) return { platform: ctx.platform, chatId };
  }
  return undefined;
}

/** Build a ScriptRef from tool params; undefined when no file was given. */
function toScriptRef(file?: string, timeoutSeconds?: number): ScriptRef | undefined {
  if (!file) return undefined;
  return { file, ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}) };
}

async function handleCreate(
  scheduler: CronScheduler,
  ctx: ToolContext,
  args: {
    name?: string;
    schedule?: string;
    prompt?: string;
    script_file?: string;
    timeout_seconds?: number;
    precheck_file?: string;
    precheck_timeout_seconds?: number;
    missed_run_policy?: 'run-once' | 'skip';
    context_from?: string[];
    repeat?: RepeatPolicy;
  },
): Promise<ToolResult> {
  const { name, schedule, prompt, missed_run_policy, context_from, repeat } = args;
  const script = toScriptRef(args.script_file, args.timeout_seconds);
  const precheck = toScriptRef(args.precheck_file, args.precheck_timeout_seconds);

  if (!name) return { ok: false, error: 'name is required', code: 'input_invalid' };
  if (!schedule) return { ok: false, error: 'schedule is required', code: 'input_invalid' };
  if (prompt && script) {
    return {
      ok: false,
      error: 'prompt and script_file are mutually exclusive — set one, not both',
      code: 'input_invalid',
    };
  }
  if (!prompt && !script) {
    return { ok: false, error: 'prompt or script_file is required', code: 'input_invalid' };
  }
  if (precheck && !prompt) {
    return {
      ok: false,
      error: 'precheck_file is only allowed on prompt jobs',
      code: 'input_invalid',
    };
  }

  const callerPersonality = ctx.personalityId;
  if (!callerPersonality) {
    return {
      ok: false,
      error: 'cron jobs require a personality context',
      code: 'input_invalid',
    };
  }

  if (!isValidSchedule(schedule)) {
    return {
      ok: false,
      error: `Invalid schedule: "${schedule}". Examples: "0 8 * * 1-5" (cron), "30m" (delay), "every 2h" (interval), "2026-06-01T09:00:00Z" (ISO).`,
      code: 'input_invalid',
    };
  }

  // Safety scan: reject prompts that look like injection attempts
  if (prompt) {
    const safetyResult = shortPatternCheck(prompt);
    if (safetyResult.containsInstructions) {
      const reasons = safetyResult.hits.map((h) => h.rule).join(', ');
      return {
        ok: false,
        error: `Prompt rejected by safety scan: ${reasons}`,
        code: 'input_invalid',
      };
    }
  }

  const origin = extractOrigin(ctx);

  try {
    // scheduler.createJob enforces the scripts-dir path guards and the
    // must-already-exist rule for script/precheck files (plan §5.1c).
    const job = await scheduler.createJob({
      name,
      schedule,
      ...(prompt ? { prompt } : {}),
      ...(script ? { script } : {}),
      ...(precheck ? { precheck } : {}),
      personalityId: callerPersonality,
      missedRunPolicy: missed_run_policy ?? 'skip',
      repeat: repeat ?? { kind: 'forever' },
      ...(origin ? { origin } : {}),
      ...(context_from ? { contextFrom: context_from } : {}),
    });

    const next = nextRunForSchedule(schedule, new Date());
    const nextStr = next ? next.toLocaleString() : 'unknown';

    return {
      ok: true,
      value: `✓ Created job "${job.name}" (id: ${job.id})\nSchedule: ${schedule}\nNext run: ${nextStr}`,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      code: 'execution_failed',
    };
  }
}

async function handleList(
  scheduler: CronScheduler,
  args: { personalityId?: string },
): Promise<ToolResult> {
  let jobs = await scheduler.listJobs();

  if (args.personalityId) {
    jobs = jobs.filter((j) => j.personalityId === args.personalityId);
  }

  if (jobs.length === 0) {
    return {
      ok: true,
      value: 'No cron jobs scheduled. Use cron({ action: "create", ... }) to add one.',
    };
  }

  const lines = jobs.map((j) => formatJob(j));
  return {
    ok: true,
    value: `${jobs.length} cron job${jobs.length === 1 ? '' : 's'}:\n\n${lines.join('\n\n')}`,
  };
}

async function handleGet(scheduler: CronScheduler, args: { id?: string }): Promise<ToolResult> {
  if (!args.id) return { ok: false, error: 'id is required', code: 'input_invalid' };

  const job = await scheduler.getJob(args.id);
  if (!job) return { ok: false, error: `Job not found: ${args.id}`, code: 'input_invalid' };

  let runs: CronRunInfo[] = [];
  try {
    runs = await scheduler.listRuns(args.id);
  } catch {
    // non-fatal — runs may not exist yet
  }

  const recentTimestamps = runs.map((r) => r.ranAt);
  return {
    ok: true,
    value: `${formatJob(job)}\n  Recent runs: ${recentTimestamps.length > 0 ? recentTimestamps.join(', ') : 'none'}`,
  };
}

async function handleReadRun(
  scheduler: CronScheduler,
  args: { id?: string; at?: string },
): Promise<ToolResult> {
  if (!args.id) return { ok: false, error: 'id is required', code: 'input_invalid' };
  if (!args.at) return { ok: false, error: 'at is required', code: 'input_invalid' };

  let runs: CronRunInfo[] = [];
  try {
    runs = await scheduler.listRuns(args.id);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      code: 'execution_failed',
    };
  }

  const match = runs.find((r) => r.ranAt === args.at);
  if (!match) {
    return {
      ok: false,
      error: `No run found at ${args.at} for job "${args.id}"`,
      code: 'input_invalid',
    };
  }

  try {
    const output = await scheduler.readRunOutput(match.outputPath);
    return { ok: true, value: output };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      code: 'execution_failed',
    };
  }
}

async function handleUpdate(
  scheduler: CronScheduler,
  args: {
    id?: string;
    name?: string;
    schedule?: string;
    prompt?: string;
    script_file?: string;
    timeout_seconds?: number;
    precheck_file?: string;
    precheck_timeout_seconds?: number;
  },
): Promise<ToolResult> {
  if (!args.id) return { ok: false, error: 'id is required', code: 'input_invalid' };
  if (!args.name && !args.schedule && !args.prompt && !args.script_file && !args.precheck_file) {
    return {
      ok: false,
      error: 'At least one of name, schedule, prompt, script_file, or precheck_file is required',
      code: 'input_invalid',
    };
  }

  // Safety scan: reject updated prompts that look like injection attempts
  if (args.prompt) {
    const safetyResult = shortPatternCheck(args.prompt);
    if (safetyResult.containsInstructions) {
      const reasons = safetyResult.hits.map((h) => h.rule).join(', ');
      return {
        ok: false,
        error: `Prompt rejected by safety scan: ${reasons}`,
        code: 'input_invalid',
      };
    }
  }

  try {
    const patch: CronJobUpdate = {};
    if (args.name) patch.name = args.name;
    if (args.schedule) patch.schedule = args.schedule;
    if (args.prompt) patch.prompt = args.prompt;
    const script = toScriptRef(args.script_file, args.timeout_seconds);
    if (script) patch.script = script;
    const precheck = toScriptRef(args.precheck_file, args.precheck_timeout_seconds);
    if (precheck) patch.precheck = precheck;

    const updated = await scheduler.updateJob(args.id, patch);
    return {
      ok: true,
      value: `✓ Updated job "${updated.name}" (${updated.id})\nSchedule: ${updated.schedule}${updated.nextRunAt ? `\nNext run: ${new Date(updated.nextRunAt).toLocaleString()}` : ''}`,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      code: 'execution_failed',
    };
  }
}

async function handlePause(scheduler: CronScheduler, args: { id?: string }): Promise<ToolResult> {
  if (!args.id) return { ok: false, error: 'id is required', code: 'input_invalid' };
  const job = await scheduler.getJob(args.id);
  if (job?.source === 'system') {
    return {
      ok: false,
      error: 'Cannot pause system job — managed by operator config',
      code: 'input_invalid',
    };
  }
  try {
    await scheduler.pauseJob(args.id);
    return { ok: true, value: `✓ Paused job "${args.id}"` };
  } catch (err) {
    return { ok: false, error: String(err), code: 'execution_failed' };
  }
}

async function handleResume(scheduler: CronScheduler, args: { id?: string }): Promise<ToolResult> {
  if (!args.id) return { ok: false, error: 'id is required', code: 'input_invalid' };
  try {
    await scheduler.resumeJob(args.id);
    return { ok: true, value: `✓ Resumed job "${args.id}"` };
  } catch (err) {
    return { ok: false, error: String(err), code: 'execution_failed' };
  }
}

async function handleRun(scheduler: CronScheduler, args: { id?: string }): Promise<ToolResult> {
  if (!args.id) return { ok: false, error: 'id is required', code: 'input_invalid' };
  try {
    const result = await scheduler.runJobNow(args.id);
    return {
      ok: true,
      value: `✓ Ran job "${args.id}"\n\nOutput:\n${result.output}`,
    };
  } catch (err) {
    return { ok: false, error: String(err), code: 'execution_failed' };
  }
}

async function handleRemove(scheduler: CronScheduler, args: { id?: string }): Promise<ToolResult> {
  if (!args.id) return { ok: false, error: 'id is required', code: 'input_invalid' };
  const job = await scheduler.getJob(args.id);
  if (job?.source === 'system') {
    return {
      ok: false,
      error: 'Cannot delete system job — managed by operator config',
      code: 'input_invalid',
    };
  }
  try {
    await scheduler.deleteJob(args.id);
    return { ok: true, value: `✓ Deleted job "${args.id}"` };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      code: 'execution_failed',
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatJob(j: CronJob): string {
  const statusMap: Record<string, string> = {
    active: '▶ active',
    paused: '⏸ paused',
    done: '✓ done',
  };
  const status = statusMap[j.status] ?? j.status;
  const next = j.nextRunAt ? new Date(j.nextRunAt).toLocaleString() : 'not scheduled';
  const last = j.lastRunAt ? new Date(j.lastRunAt).toLocaleString() : 'never';
  return [
    `**${j.name}** (${j.id})`,
    `  Status:      ${status}`,
    `  Schedule:    ${j.schedule}`,
    `  Personality: ${j.personalityId}`,
    `  Next run:    ${next}`,
    `  Last run:    ${last}`,
    `  Missed runs: ${j.missedRunPolicy}`,
  ].join('\n');
}
