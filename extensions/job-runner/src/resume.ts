import type { BackgroundJob, BackgroundJobEvent, JobRunnerContext } from '@ethosagent/types';

// Pure helpers of a durable resume (plan durable-background-jobs D1/D4): what the
// executor tells a runner (`JobRunnerContext.resume`) and what the resumed child
// is asked to do. Pinned by `__tests__/resume.test.ts`.

type Resume = NonNullable<JobRunnerContext['resume']>;

/**
 * The `ctx.resume` for this claim: undefined unless the row was requeued
 * (`requeuedAt`). A manual resume is not counted in `resumeCount`, so the
 * trigger is `requeuedAt`; reason, attempt and interrupted tools come from the
 * newest `requeued` event in `events` (`SQLiteJobStore.appendRequeuedSync`
 * records them at requeue time), falling back to the row's counter.
 */
export function resumeContextFor(
  job: Pick<BackgroundJob, 'requeuedAt' | 'resumeCount'>,
  events: readonly BackgroundJobEvent[],
): Resume | undefined {
  if (job.requeuedAt === undefined) return undefined;
  const requeued = [...events].reverse().find((e) => e.eventType === 'requeued');
  const raw = requeued?.payload.reason;
  const reason: Resume['reason'] =
    raw === 'crash' || raw === 'manual' || raw === 'restart' ? raw : 'restart';
  const rawAttempt = requeued?.payload.attempt;
  const attempt = typeof rawAttempt === 'number' ? rawAttempt : (job.resumeCount ?? 0);
  const rawTools = requeued?.payload.interruptedTools;
  const interruptedTools = Array.isArray(rawTools)
    ? rawTools.filter((t): t is string => typeof t === 'string')
    : [];
  return { attempt, reason, interruptedTools };
}

const CAUSE: Record<Resume['reason'], string> = {
  restart: 'interrupted by a restart',
  crash: 'interrupted (the process stopped unexpectedly)',
  manual: 'stopped and then resumed by the user',
};

/**
 * The prompt a resumed child runs on its existing session, in place of the
 * original task prompt (the task is already in the session history).
 */
export function resumePrompt(resume: Resume): string {
  const tools = resume.interruptedTools;
  const head = `This background task was ${CAUSE[resume.reason]}`;
  if (tools.length === 0) {
    return `${head}. Please check the work already done before repeating any step, then continue the original task.`;
  }
  return (
    `${head} while running: ${tools.join(', ')}. ` +
    'Those calls may or may not have taken effect. Verify what they changed before relying on them, ' +
    'then continue the original task.'
  );
}
