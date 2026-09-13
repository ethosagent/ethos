// Readable text for a refused learning decision (plan `trust-before-reach.md`
// Part 4). The codes are the `LearningInbox` refusals upper-cased onto the wire
// by `apps/web-api/src/rpc/learning.ts`; the rules behind them — the override
// reason above all — are enforced server-side in `LearningInbox.approve`
// (`extensions/learning-inbox/src/inbox.ts`), never here. A code this table does
// not name falls back to the caller's title and the server's own message.

const TITLES: Record<string, string> = {
  OVERRIDE_REQUIRED: 'Needs a reason — this change has not passed a replay',
  STALE: 'Not applied — the live file changed since this was drafted',
  INVALID: 'Not applied — the proposed file is invalid',
  NOT_PROMOTABLE: 'Already decided — this candidate is no longer waiting',
  NOT_FOUND: 'Not found — this candidate no longer exists',
  AMBIGUOUS: 'More than one candidate matches',
};

/** Narrow read of an oRPC error's `code` without casting a typed value. */
function errorCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err) {
    const code: unknown = Reflect.get(err, 'code');
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

export interface LearningRefusal {
  code: string | undefined;
  /** A readable headline for the refusal. */
  title: string;
  /** The server's reason, verbatim. */
  detail: string;
}

export function learningRefusal(err: unknown, fallbackTitle: string): LearningRefusal {
  const code = errorCode(err);
  return {
    code,
    title: (code ? TITLES[code] : undefined) ?? fallbackTitle,
    detail: err instanceof Error ? err.message : String(err),
  };
}
