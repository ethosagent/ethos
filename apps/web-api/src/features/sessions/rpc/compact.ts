import { os } from '../../../rpc/context';

// Phase 2 — manual `/compact`. Resolves the session key from its id and forces a
// compaction via the shared AgentLoop, which persists a watermark so the
// compaction survives into later turns. Returns pre/post token counts for the
// confirmation notice. When no AgentLoop is wired (onboarding, tests) or the
// session is unknown, reports `ok: false` rather than throwing.
export const sessionsCompact = os.sessions.compact.handler(async ({ input, context }) => {
  const empty = {
    ok: false,
    engineName: 'none',
    droppedCount: 0,
    preTotalTokens: 0,
    postTotalTokens: 0,
    summariesEnabled: false,
  };
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
