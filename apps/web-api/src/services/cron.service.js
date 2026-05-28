import { EthosError } from '@ethosagent/types';
export class CronService {
  opts;
  constructor(opts) {
    this.opts = opts;
  }
  async list() {
    const jobs = await this.opts.scheduler.listJobs();
    return { jobs: jobs.map(toWireJob) };
  }
  async get(id) {
    const job = await this.opts.scheduler.getJob(id);
    if (!job) throw notFound(id);
    return { job: toWireJob(job) };
  }
  async create(input) {
    try {
      const job = await this.opts.scheduler.createJob({
        name: input.name,
        schedule: input.schedule,
        prompt: input.prompt,
        personalityId: input.personalityId,
        missedRunPolicy: input.missedRunPolicy ?? 'skip',
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
  async update(id, patch) {
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
  async delete(id) {
    try {
      await this.opts.scheduler.deleteJob(id);
    } catch (err) {
      if (isNotFoundError(err)) throw notFound(id);
      throw err;
    }
  }
  async pause(id) {
    try {
      await this.opts.scheduler.pauseJob(id);
    } catch (err) {
      if (isNotFoundError(err)) throw notFound(id);
      throw err;
    }
  }
  async resume(id) {
    try {
      await this.opts.scheduler.resumeJob(id);
    } catch (err) {
      if (isNotFoundError(err)) throw notFound(id);
      throw err;
    }
  }
  async runNow(id) {
    const job = await this.opts.scheduler.getJob(id);
    if (!job) throw notFound(id);
    const result = await this.opts.scheduler.runJobNow(id);
    return { output: result.output, ranAt: result.ranAt };
  }
  async history(id, limit) {
    const infos = await this.opts.scheduler.listRuns(id, limit);
    if (infos.length === 0) return { runs: [] };
    const runs = infos.map((info) => ({
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
function toWireJob(job) {
  return {
    id: job.id,
    name: job.name,
    schedule: job.schedule,
    prompt: job.prompt,
    personalityId: job.personalityId,
    deliver: job.origin?.platform ?? null,
    status: job.status,
    missedRunPolicy: job.missedRunPolicy,
    lastRunAt: job.lastRunAt ?? null,
    nextRunAt: job.nextRunAt ?? null,
    createdAt: job.createdAt,
  };
}
function notFound(id) {
  return new EthosError({
    code: 'JOB_NOT_FOUND',
    cause: `Cron job "${id}" not found`,
    action: 'Use cron.list to see currently registered jobs.',
  });
}
function isNotFoundError(err) {
  return err instanceof Error && /not found/i.test(err.message);
}
