import type { CronScheduler, CronJob as ExtCronJob } from '@ethosagent/cron';
import { EthosError } from '@ethosagent/types';
import type { CronJob, CronRun } from '@ethosagent/web-contracts';

// Cron orchestration. Wraps the CronScheduler — job CRUD + tick loop +
// run-history reads (`listRuns`/`readRunOutput`) — into the wire shape
// the web tab consumes. Pure business logic — no Hono context, no oRPC.

export interface CronCreateInput {
  name: string;
  schedule: string;
  prompt: string;
  personalityId: string;
  missedRunPolicy?: 'run-once' | 'skip';
  notifyInApp?: boolean;
}

export interface CronRunNowOutput {
  output: string;
  ranAt: string;
}

export interface CronServiceOptions {
  scheduler: CronScheduler;
}

export class CronService {
  constructor(private readonly opts: CronServiceOptions) {}

  async list(): Promise<{ jobs: CronJob[] }> {
    const jobs = await this.opts.scheduler.listJobs();
    return { jobs: jobs.map(toWireJob) };
  }

  async get(id: string): Promise<{ job: CronJob }> {
    const job = await this.opts.scheduler.getJob(id);
    if (!job) throw notFound(id);
    return { job: toWireJob(job) };
  }

  async create(input: CronCreateInput): Promise<{ job: CronJob }> {
    try {
      const job = await this.opts.scheduler.createJob({
        name: input.name,
        schedule: input.schedule,
        prompt: input.prompt,
        personalityId: input.personalityId,
        missedRunPolicy: input.missedRunPolicy ?? 'skip',
        // In-app heartbeat: a `web` origin routes run output into a stable,
        // openable session (one per personality) that surfaces in Activity.
        // Absent origin keeps today's behaviour — output saved to file only.
        ...(input.notifyInApp
          ? { origin: { platform: 'web', chatId: `web:heartbeat:${input.personalityId}` } }
          : {}),
      });
      return { job: toWireJob(job) };
    } catch (err) {
      // The scheduler throws plain `Error`s for validation + duplicates;
      // surface them with the right wire code so the modal can render
      // a clear inline message.
      const message = err instanceof Error ? err.message : String(err);
      throw new EthosError({
        code: 'CRON_INVALID',
        cause: message,
        action: 'Check the schedule expression (5-field cron) and that the name is unique.',
      });
    }
  }

  async update(
    id: string,
    patch: { name?: string; schedule?: string; prompt?: string },
  ): Promise<{ job: CronJob }> {
    try {
      const updated = await this.opts.scheduler.updateJob(id, patch);
      return { job: toWireJob(updated) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/not found/i.test(message)) throw notFound(id);
      throw new EthosError({
        code: 'CRON_INVALID',
        cause: message,
        action: 'Check the schedule expression and that the job exists.',
      });
    }
  }

  async delete(id: string): Promise<void> {
    try {
      await this.opts.scheduler.deleteJob(id);
    } catch (err) {
      if (isNotFoundError(err)) throw notFound(id);
      throw err;
    }
  }

  async pause(id: string): Promise<void> {
    try {
      await this.opts.scheduler.pauseJob(id);
    } catch (err) {
      if (isNotFoundError(err)) throw notFound(id);
      throw err;
    }
  }

  async resume(id: string): Promise<void> {
    try {
      await this.opts.scheduler.resumeJob(id);
    } catch (err) {
      if (isNotFoundError(err)) throw notFound(id);
      throw err;
    }
  }

  async runNow(id: string): Promise<CronRunNowOutput> {
    const job = await this.opts.scheduler.getJob(id);
    if (!job) throw notFound(id);
    const result = await this.opts.scheduler.runJobNow(id);
    return { output: result.output, ranAt: result.ranAt };
  }

  async history(id: string, limit?: number): Promise<{ runs: CronRun[] }> {
    const infos = await this.opts.scheduler.listRuns(id, limit);
    if (infos.length === 0) return { runs: [] };

    const runs: CronRun[] = infos.map((info) => ({
      ranAt: info.ranAt,
      outputPath: info.outputPath,
      output: null,
    }));

    // Hydrate the head run's body so the UI can show the most recent
    // output without a second round-trip; the rest stay metadata-only.
    const head = runs[0];
    if (head) {
      try {
        head.output = await this.opts.scheduler.readRunOutput(head.outputPath);
      } catch {
        // file vanished between listing and read — leave the metadata.
      }
    }
    return { runs };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toWireJob(job: ExtCronJob): CronJob {
  return {
    id: job.id,
    name: job.name,
    schedule: job.schedule,
    prompt: job.prompt ?? '',
    personalityId: job.personalityId,
    deliver: job.origin?.platform ?? null,
    status: job.status,
    missedRunPolicy: job.missedRunPolicy,
    source: (job.source ?? 'user') as 'system' | 'user',
    systemTask: job.systemTask ?? null,
    lastRunAt: job.lastRunAt ?? null,
    nextRunAt: job.nextRunAt ?? null,
    createdAt: job.createdAt,
  };
}

function notFound(id: string): EthosError {
  return new EthosError({
    code: 'JOB_NOT_FOUND',
    cause: `Cron job "${id}" not found`,
    action: 'Use cron.list to see currently registered jobs.',
  });
}

function isNotFoundError(err: unknown): boolean {
  return err instanceof Error && /not found/i.test(err.message);
}
