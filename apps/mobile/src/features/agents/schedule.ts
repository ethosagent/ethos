import type { RowData } from '../../lib/row';
import { clock } from '../../lib/row';

// Agent › Schedule (§5): the personality's cron jobs, and their recent firings
// as feedback rows. `cron.list` takes no filter, so the phone filters.

export interface CronJobLike {
  id: string;
  name: string;
  personalityId: string;
}

export interface CronRunLike {
  ranAt: string;
  outputPath: string;
  /** Only the head run of `cron.history` carries its body. */
  output: string | null;
}

export function jobsFor<J extends CronJobLike>(jobs: readonly J[], personalityId: string): J[] {
  return jobs.filter((j) => j.personalityId === personalityId);
}

/** The body the scheduler persisted, minus its `# <job name>` title line
 *  (`CronScheduler.persistRun`, extensions/cron/src/index.ts). */
function body(output: string): string {
  return output.replace(/^# .*\n+/, '').trim();
}

// A script job that failed persists `[script failed] <reason>`
// (`CronScheduler.executeScriptJob`). Nothing else in a run file marks a
// failure — `CronRun` carries no status — so an agent run that threw leaves
// no file at all, and a listed run without a body reads as `ran`.
const SCRIPT_FAILED = '[script failed] ';

export function firingRow(job: CronJobLike, run: CronRunLike): RowData {
  const time = clock(Date.parse(run.ranAt));
  if (run.output === null) return { glyph: '·', word: 'ran', subject: job.name, time };
  const text = body(run.output);
  if (text.startsWith(SCRIPT_FAILED)) {
    return {
      glyph: '✗',
      word: 'failed',
      subject: job.name,
      result: text.slice(SCRIPT_FAILED.length),
      time,
    };
  }
  const first = text.split('\n').find((l) => l.trim() !== '') ?? '';
  return { glyph: '✓', word: 'ran', subject: job.name, result: first || '(no output)', time };
}

/** Every job's firings, newest first, capped. */
export function recentFirings(
  entries: ReadonlyArray<{ job: CronJobLike; runs: readonly CronRunLike[] }>,
  limit = 10,
): Array<{ key: string; ranAt: string; row: RowData }> {
  return entries
    .flatMap(({ job, runs }) =>
      runs.map((run) => ({ key: run.outputPath, ranAt: run.ranAt, row: firingRow(job, run) })),
    )
    .sort((a, b) => (a.ranAt < b.ranAt ? 1 : -1))
    .slice(0, limit);
}
