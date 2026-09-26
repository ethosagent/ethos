import { join } from 'node:path';
import { type EthosConfig, ethosCronDir, ethosDir, ethosScriptsDir } from '@ethosagent/config';
import type { AgentLoop } from '@ethosagent/core';
import {
  type CronJobUpdate,
  CronProgressRecorder,
  CronScheduler,
  isValidSchedule,
  nextRunForSchedule,
  type ScriptRef,
} from '@ethosagent/cron';
import { ConsoleLogger } from '@ethosagent/logger';
import { createPersonalityRegistry } from '@ethosagent/personalities';
import { answerSuffix, EthosError } from '@ethosagent/types';
import { writeJson } from '../json-output';
import { gateCronLoop } from '../lib/non-interactive-approval';
import { releaseCommandRuntime } from '../lib/release-command-runtime';
import { createAgentLoop, getEthosObservability, getStorage } from '../wiring';

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
};

/** Build a ScriptRef from CLI flags; the scheduler validates path + timeout. */
function toScriptRef(file?: string, timeout?: string): ScriptRef | undefined {
  if (!file) return undefined;
  return { file, ...(timeout !== undefined ? { timeoutSeconds: Number(timeout) } : {}) };
}

function makeScheduler(config: EthosConfig): {
  scheduler: CronScheduler;
  cleanup: () => Promise<void>;
} {
  let loop: AgentLoop | null = null;
  let runtime: Awaited<ReturnType<typeof createAgentLoop>> | null = null;
  let personalities: Awaited<ReturnType<typeof createPersonalityRegistry>> | null = null;

  const scheduler = new CronScheduler({
    storage: getStorage(),
    cronDir: ethosCronDir(),
    scriptsDir: ethosScriptsDir(),
    logger: new ConsoleLogger({}, config.logs?.level),
    ...(config.cron?.defaultMaxRunMs !== undefined
      ? { defaultMaxRunMs: config.cron.defaultMaxRunMs }
      : {}),
    ...(config.cron?.maxParallelJobs !== undefined
      ? { maxParallelJobs: config.cron.maxParallelJobs }
      : {}),
    onDecision: (job, d) => {
      try {
        getEthosObservability().recordHeartbeatDecision({
          personalityId: job.personalityId,
          jobId: job.id,
          decision: d.action,
          delivered: d.delivered,
        });
      } catch {
        // observability unavailable — audit is fail-open
      }
    },
    runJob: async (job, runOpts) => {
      if (!personalities) {
        personalities = await createPersonalityRegistry(getStorage());
        await personalities.loadFromDirectory(join(ethosDir(), 'personalities'));
      }
      if (!personalities.get(job.personalityId)) {
        throw new EthosError({
          code: 'CRON_PERSONALITY_MISSING',
          cause: `Personality "${job.personalityId}" not found for cron job "${job.id}"`,
          action: `Run 'ethos cron list' to find affected jobs, then update or delete them`,
        });
      }
      if (!loop) {
        runtime = await createAgentLoop(config);
        gateCronLoop(runtime, config);
        loop = runtime.loop;
      }
      const sessionKey = `cron:${job.id}:${new Date().toISOString()}`;
      let output = '';

      // Recursion guard: exclude 'cron' from the effective toolset so
      // cron-spawned sessions cannot schedule further cron jobs.
      if (!personalities) {
        personalities = await createPersonalityRegistry(getStorage());
        await personalities.loadFromDirectory(join(ethosDir(), 'personalities'));
      }
      const pid = job.personalityId;
      const pers = personalities.get(pid);
      const toolsetOverride = pers?.toolset?.filter((t: string) => t !== 'cron');

      // Progress is collected separately from `output` — never appended to it.
      // `output` is delivered verbatim and `decideEscalation` tests it with a
      // start-anchored `[SILENT]` regex. The recorder gates on
      // `audience: 'user'`; internal progress stays internal.
      const progress = new CronProgressRecorder();
      for await (const event of loop.run(job.prompt ?? '', {
        sessionKey,
        personalityId: pid,
        toolsetOverride,
        // R10 — the scheduler aborts this at the job's `maxRunMs`.
        abortSignal: runOpts?.abortSignal,
      })) {
        if (event.type === 'text_delta') output += event.text;
        // A `returnDirect` tool's answer arrives only as `done.text`, after
        // any preamble that streamed — same rule as `runCronTurn`.
        else if (event.type === 'done') output += answerSuffix(output, event.text);
        else progress.record(event);
      }

      return {
        jobId: job.id,
        ranAt: new Date().toISOString(),
        output,
        sessionKey,
        progress: progress.snapshot(),
      };
    },
  });

  // The CLI never starts a trigger loop (each subcommand is a one-shot CRUD
  // or `runJobNow` call, not a long-running daemon), so there is no trigger to
  // stop — `start()`/`stop()` moved off `CronScheduler` onto
  // `LocalIntervalTrigger` (plan/completed/cron-scheduler-seam.md). What
  // `cleanup` DOES own is the agent loop `runJob` builds lazily: `ethos cron
  // run` is the one subcommand that constructs one, and it used to exit on top
  // of it (G4).
  return {
    scheduler,
    cleanup: async () => {
      const built = runtime;
      runtime = null;
      loop = null;
      if (built) await releaseCommandRuntime(built, { label: 'cron agent loop' });
    },
  };
}

export async function runCronCommand(
  sub: string,
  args: string[],
  config: EthosConfig,
): Promise<void> {
  switch (sub) {
    case 'list': {
      const params = parseFlags(args);
      const filterPersonality = params.personality;
      const jsonMode = args.includes('--json');
      const { scheduler, cleanup } = makeScheduler(config);
      try {
        let jobs = await scheduler.listJobs();
        if (filterPersonality) {
          jobs = jobs.filter((j) => j.personalityId === filterPersonality);
        }
        if (jsonMode) {
          writeJson(
            jobs.map((j) => ({
              id: j.id,
              name: j.name,
              status: j.status,
              schedule: j.schedule,
              personalityId: j.personalityId,
              nextRun: j.nextRunAt ? new Date(j.nextRunAt).toISOString() : null,
              lastRun: j.lastRunAt ? new Date(j.lastRunAt).toISOString() : null,
              lastError: j.lastError ?? null,
              prompt: j.prompt,
              script: j.script,
            })),
          );
          return;
        }
        if (jobs.length === 0) {
          console.log(`${c.dim}No cron jobs. Create one with: ethos cron create${c.reset}`);
          return;
        }
        console.log(`\n${c.bold}Cron jobs:${c.reset}\n`);
        for (const j of jobs) {
          const statusMap: Record<string, string> = {
            active: `${c.green}▶ active${c.reset}`,
            paused: `${c.yellow}⏸ paused${c.reset}`,
            done: `${c.dim}✓ done${c.reset}`,
          };
          const status = statusMap[j.status] ?? j.status;
          const next = j.nextRunAt ? new Date(j.nextRunAt).toLocaleString() : 'not scheduled';
          const pers = j.personalityId;
          console.log(`  ${c.bold}${j.name}${c.reset} ${c.dim}(${j.id})${c.reset} — ${status}`);
          console.log(`    Schedule    : ${j.schedule}`);
          console.log(`    Personality : ${pers}`);
          console.log(`    Next run    : ${next}`);
          // N4 — whether the last firing worked, not just when the next one is.
          const outcome = cronLastOutcome(j);
          console.log(
            `    Last run    : ${outcome.startsWith('failed') ? `${c.red}${outcome}${c.reset}` : outcome}`,
          );
          const preview =
            (j.script ? `[script: ${j.script.file}]` : j.prompt) ??
            (j.systemTask ? `[system: ${j.systemTask}]` : '—');
          console.log(
            `    ${j.script ? 'Script' : 'Prompt'}      : ${preview.slice(0, 80)}${preview.length > 80 ? '…' : ''}`,
          );
          console.log();
        }
      } finally {
        await cleanup();
      }
      break;
    }

    case 'show': {
      const id = args[0] === '--json' ? undefined : args[0];
      const jsonMode = args.includes('--json');
      if (!id) {
        console.log('Usage: ethos cron show <id>');
        return;
      }
      const { scheduler, cleanup } = makeScheduler(config);
      try {
        const j = await scheduler.getJob(id);
        if (!j) {
          console.log(`${c.red}Job not found: ${id}${c.reset}`);
          return;
        }
        if (jsonMode) {
          writeJson({
            id: j.id,
            name: j.name,
            status: j.status,
            schedule: j.schedule,
            personalityId: j.personalityId,
            prompt: j.prompt,
            script: j.script,
            lastRun: j.lastRunAt ? new Date(j.lastRunAt).toISOString() : null,
          });
          return;
        }
        const showStatusMap: Record<string, string> = {
          active: `${c.green}▶ active${c.reset}`,
          paused: `${c.yellow}⏸ paused${c.reset}`,
          done: `${c.dim}✓ done${c.reset}`,
        };
        const status = showStatusMap[j.status] ?? j.status;
        const pers = j.personalityId;
        console.log(`\n${c.bold}${j.name}${c.reset} ${c.dim}(${j.id})${c.reset}`);
        console.log(`  Status      : ${status}`);
        console.log(`  Personality : ${c.cyan}${pers}${c.reset}`);
        console.log(`  Schedule    : ${j.schedule}`);
        console.log(
          `  Next run    : ${j.nextRunAt ? new Date(j.nextRunAt).toLocaleString() : 'not scheduled'}`,
        );
        console.log(
          `  Last run    : ${j.lastRunAt ? new Date(j.lastRunAt).toLocaleString() : 'never'}`,
        );
        console.log(
          `  ${j.script ? 'Script' : 'Prompt'}      : ${(j.script ? `[script: ${j.script.file}]` : j.prompt) ?? (j.systemTask ? `[system: ${j.systemTask}]` : '—')}`,
        );
        if (j.precheck) {
          console.log(`  Precheck    : ${j.precheck.file}`);
        }
        console.log();
      } finally {
        await cleanup();
      }
      break;
    }

    case 'create': {
      // ethos cron create --name "..." --schedule "..." (--prompt "..." | --script file.sh)
      //   [--script-timeout <sec>] [--precheck file.sh] [--precheck-timeout <sec>] [--personality X]
      const params = parseFlags(args);
      const name = params.name ?? params.n;
      const schedule = params.schedule ?? params.s;
      const prompt = params.prompt ?? params.p;
      const script = toScriptRef(params.script, params['script-timeout']);
      const precheck = toScriptRef(params.precheck, params['precheck-timeout']);
      const personality = params.personality;

      if (prompt && script) {
        console.log(`${c.red}--prompt and --script are mutually exclusive${c.reset}`);
        return;
      }

      if (precheck && !prompt) {
        console.log(`${c.red}--precheck is only allowed on prompt jobs${c.reset}`);
        return;
      }

      if (!name || !schedule || (!prompt && !script)) {
        console.log(
          'Usage: ethos cron create --name "Job name" --schedule "0 8 * * *" (--prompt "Your prompt" | --script file.sh)',
        );
        console.log(
          `${c.dim}Script files are relative to ~/.ethos/scripts/ and must already exist (.sh or .py).${c.reset}`,
        );
        return;
      }

      if (!isValidSchedule(schedule)) {
        console.log(`${c.red}Invalid schedule: "${schedule}"${c.reset}`);
        console.log(
          `${c.dim}Examples: "0 8 * * 1-5" (cron), "30m" (delay), "every 2h" (interval)${c.reset}`,
        );
        return;
      }

      if (personality) {
        const reg = await createPersonalityRegistry(getStorage());
        await reg.loadFromDirectory(join(ethosDir(), 'personalities'));
        if (!reg.get(personality)) {
          console.log(`${c.red}Personality "${personality}" not found${c.reset}`);
          console.log(
            `${c.dim}Run 'ethos personality list' to see available personalities${c.reset}`,
          );
          return;
        }
      }

      const { scheduler, cleanup } = makeScheduler(config);
      try {
        const job = await scheduler.createJob({
          name,
          schedule,
          ...(prompt ? { prompt } : {}),
          ...(script ? { script } : {}),
          ...(precheck ? { precheck } : {}),
          personalityId: personality ?? config.personality,
          repeat: { kind: 'forever' },
          missedRunPolicy: 'skip',
        });
        const next = nextRunForSchedule(schedule, new Date());
        console.log(`${c.green}✓ Created "${job.name}" (${job.id})${c.reset}`);
        if (next) console.log(`${c.dim}Next run: ${next.toLocaleString()}${c.reset}`);
      } finally {
        await cleanup();
      }
      break;
    }

    case 'update': {
      const id = args[0];
      if (!id) {
        console.log(
          'Usage: ethos cron update <id> [--name "..."] [--schedule "..."] [--prompt "..."] [--script file.sh] [--precheck file.sh]',
        );
        return;
      }
      const params = parseFlags(args.slice(1));
      const patch: CronJobUpdate = {};
      if (params.name) patch.name = params.name;
      if (params.schedule) patch.schedule = params.schedule;
      if (params.prompt) patch.prompt = params.prompt;
      const scriptPatch = toScriptRef(params.script, params['script-timeout']);
      if (scriptPatch) patch.script = scriptPatch;
      const precheckPatch = toScriptRef(params.precheck, params['precheck-timeout']);
      if (precheckPatch) patch.precheck = precheckPatch;

      if (Object.keys(patch).length === 0) {
        console.log(
          'At least one of --name, --schedule, --prompt, --script, or --precheck is required',
        );
        return;
      }

      const { scheduler, cleanup } = makeScheduler(config);
      try {
        const updated = await scheduler.updateJob(id, patch);
        console.log(`${c.green}✓ Updated "${updated.name}" (${updated.id})${c.reset}`);
        if (updated.nextRunAt) {
          console.log(
            `${c.dim}Next run: ${new Date(updated.nextRunAt).toLocaleString()}${c.reset}`,
          );
        }
      } catch (err) {
        console.log(`${c.red}${err instanceof Error ? err.message : String(err)}${c.reset}`);
      } finally {
        await cleanup();
      }
      break;
    }

    case 'pause': {
      const id = args[0];
      if (!id) {
        console.log('Usage: ethos cron pause <id>');
        return;
      }
      const { scheduler, cleanup } = makeScheduler(config);
      try {
        const job = await scheduler.getJob(id);
        if (job?.source === 'system') {
          console.log(
            `${c.red}Cannot pause system job "${id}" — managed by operator config${c.reset}`,
          );
          return;
        }
        await scheduler.pauseJob(id);
        console.log(`${c.green}✓ Paused "${id}"${c.reset}`);
      } catch (err) {
        console.log(`${c.red}${err instanceof Error ? err.message : String(err)}${c.reset}`);
      } finally {
        await cleanup();
      }
      break;
    }

    case 'resume': {
      const id = args[0];
      if (!id) {
        console.log('Usage: ethos cron resume <id>');
        return;
      }
      const { scheduler, cleanup } = makeScheduler(config);
      try {
        await scheduler.resumeJob(id);
        console.log(`${c.green}✓ Resumed "${id}"${c.reset}`);
      } catch (err) {
        console.log(`${c.red}${err instanceof Error ? err.message : String(err)}${c.reset}`);
      } finally {
        await cleanup();
      }
      break;
    }

    case 'delete': {
      const id = args[0];
      if (!id) {
        console.log('Usage: ethos cron delete <id>');
        return;
      }
      const { scheduler, cleanup } = makeScheduler(config);
      try {
        const job = await scheduler.getJob(id);
        if (job?.source === 'system') {
          console.log(
            `${c.red}Cannot delete system job "${id}" — managed by operator config${c.reset}`,
          );
          return;
        }
        await scheduler.deleteJob(id);
        console.log(`${c.green}✓ Deleted "${id}"${c.reset}`);
      } catch (err) {
        console.log(`${c.red}${err instanceof Error ? err.message : String(err)}${c.reset}`);
      } finally {
        await cleanup();
      }
      break;
    }

    case 'run': {
      const id = args[0];
      if (!id) {
        console.log('Usage: ethos cron run <id>');
        return;
      }
      const { scheduler, cleanup } = makeScheduler(config);
      try {
        console.log(`${c.dim}Running job "${id}"...${c.reset}`);
        const result = await scheduler.runJobNow(id);
        console.log(`\n${result.output}`);
      } catch (err) {
        console.log(`${c.red}${err instanceof Error ? err.message : String(err)}${c.reset}`);
      } finally {
        await cleanup();
      }
      break;
    }

    default:
      console.log(
        'Usage: ethos cron [list [--personality <id>] | show <id> | create | update <id> | pause | resume | delete | run]',
      );
  }
}

/**
 * N4 — `last: ok 2h ago` / `last: failed 10m ago` / `never`, from the two
 * fields the cron store records per job (`lastRunAt` + `lastError`,
 * extensions/cron/src/index.ts). Limitation: the store keeps no per-run
 * outcome history and `lastError` is written on failure but never cleared by
 * a later success — a job that failed once keeps reading `failed` even after
 * it has recovered, until the field changes again. Named here rather than
 * guessed around; `ethos cron show <id>` has the detail.
 * Exported for `__tests__/cron-list-outcome.test.ts`.
 */
export function cronLastOutcome(
  job: { lastRunAt?: string; lastError?: string },
  now = Date.now(),
): string {
  if (!job.lastRunAt) return 'never';
  const ranAt = Date.parse(job.lastRunAt);
  const ago = Number.isFinite(ranAt) ? cronAgo(now - ranAt) : job.lastRunAt;
  return job.lastError ? `failed ${ago}` : `ok ${ago}`;
}

function cronAgo(diffMs: number): string {
  const mins = Math.floor(Math.max(diffMs, 0) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function parseFlags(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg?.startsWith('--')) {
      const key = arg.slice(2);
      const val = args[i + 1];
      if (val && !val.startsWith('--')) {
        result[key] = val;
        i++;
      }
    } else if (arg?.startsWith('-') && arg.length === 2) {
      const key = arg.slice(1);
      const val = args[i + 1];
      if (val && !val.startsWith('-')) {
        result[key] = val;
        i++;
      }
    }
  }
  return result;
}
