import type { AcceptanceSpec, GoalAttempt, Verdict } from '@ethosagent/types';

export type RetryStrategy = 'patch' | 'pivot' | 'clarify';

export function classifyFailure(attempts: GoalAttempt[], latestVerdict: Verdict): RetryStrategy {
  if (latestVerdict.score >= 0.6) return 'patch';

  if (attempts.length >= 2) {
    const prevAttempt = attempts[attempts.length - 2];
    const prevVerdict = prevAttempt?.verdict;
    if (prevVerdict && prevVerdict.score <= latestVerdict.score) return 'pivot';
  }

  return 'patch';
}

export function buildRetryContext(opts: {
  goalText: string;
  spec: AcceptanceSpec;
  attempts: GoalAttempt[];
  latestVerdict: Verdict;
  strategy: RetryStrategy;
}): string {
  const parts: string[] = [];

  parts.push(`## Goal\n${opts.goalText}`);
  parts.push(`## Acceptance Criteria\nThreshold: ${opts.spec.threshold}`);
  for (const check of opts.spec.checks) {
    parts.push(`- [CHECK] ${check.description}`);
  }
  for (const rubric of opts.spec.rubric) {
    parts.push(`- [RUBRIC w=${rubric.weight}] ${rubric.description}`);
  }

  parts.push('\n## Gap Report');
  for (const cr of opts.latestVerdict.perCriterion) {
    if (cr.pass === true || (cr.score !== undefined && cr.score >= opts.spec.threshold)) {
      parts.push(`- OK ${cr.evidence} — preserve this`);
    } else {
      parts.push(`- FAIL ${cr.gap ?? cr.evidence}`);
    }
  }

  parts.push('\n## Prior Attempts');
  for (const a of opts.attempts) {
    const v = a.verdict;
    const score = v ? v.score.toFixed(2) : '?';
    const failed = v
      ? v.perCriterion
          .filter(
            (c) => c.pass === false || (c.score !== undefined && c.score < opts.spec.threshold),
          )
          .map((c) => c.id)
          .join(', ')
      : '?';
    parts.push(`- Attempt ${a.n}: strategy=${a.strategyUsed}, score=${score}, failed=[${failed}]`);
  }

  parts.push(`\n## Strategy: ${opts.strategy.toUpperCase()}`);
  if (opts.strategy === 'patch') {
    parts.push('High score with local gaps. Revise the prior output to fix the gaps listed above.');
    const lastAttempt = opts.attempts[opts.attempts.length - 1];
    if (lastAttempt?.outputMd) {
      parts.push(`\n## Prior Output (revise this)\n${lastAttempt.outputMd}`);
    }
  } else if (opts.strategy === 'pivot') {
    parts.push(
      'Low score or repeated failure. Take a completely different approach. The following approach is banned:',
    );
    const lastAttempt = opts.attempts[opts.attempts.length - 1];
    if (lastAttempt) {
      parts.push(`- Attempt ${lastAttempt.n} (strategy: ${lastAttempt.strategyUsed})`);
    }
  }

  return parts.join('\n');
}
