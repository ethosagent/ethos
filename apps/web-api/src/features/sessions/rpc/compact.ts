import { os } from '../../../rpc/context';

// Phase 2 — manual `/compact`. Resolves the session key from its id and forces a
// compaction via the shared AgentLoop, which persists a watermark so the
// compaction survives into later turns. Returns pre/post token counts for the
// confirmation notice. Reports `ok: false` rather than throwing when the session
// is unknown, or when the loop refuses — onboarding's stand-in throws
// NOT_CONFIGURED until a loop is bound (apps/web-api/src/lib/pending-loop.ts),
// which the catch below turns into the same empty answer.
export const sessionsCompact = os.sessions.compact.handler(async ({ input, context }) => {
  const empty = {
    ok: false,
    engineName: 'none',
    droppedCount: 0,
    preTotalTokens: 0,
    postTotalTokens: 0,
    summariesEnabled: false,
  };
  // Absent only for a container built without a loop at all (tests). Onboarding
  // passes the stand-in, which refuses in the catch below instead.
  const loop = context.agentLoop;
  if (!loop) return empty;
  try {
    const { session } = await context.sessions.get(input.id);
    const result = await loop.compact(session.key, {
      ...(input.instructions ? { instructions: input.instructions } : {}),
    });
    return {
      ok: result.ok,
      engineName: result.engineName,
      droppedCount: result.droppedCount,
      preTotalTokens: result.preTotalTokens,
      postTotalTokens: result.postTotalTokens,
      summariesEnabled: result.summariesEnabled,
    };
  } catch {
    return empty;
  }
});
