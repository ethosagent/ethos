import type { AgentEvent } from '@ethosagent/types';
import { DefaultToolRegistry } from '../../tool-registry';
import type { HaltDecision } from '../turn-context';
import { type StreamStepContext, type StreamStepDeps, streamStep } from './stream-step';
import { persistAbortedToolCalls } from './tool-rejection';
import { flushTurnUsage } from './turn-finalizer';

export type WatcherPauseReply =
  | { fatal: true }
  | { fatal: false; textDelta: string; turns: number };

/**
 * D48 — a watcher `pause` still ends the turn with a reply. AgentLoop.run calls
 * this once, right after it yields the `halt` event: one closing model call
 * offered NO tools (an EMPTY registry, so not even alwaysInclude, MCP or plugin
 * tools) with the halt appended to the system prompt's tail, so the user is
 * told what happened instead of receiving an empty reply. finalizeTurn's `done`
 * still follows. The `terminate` path does not come here. Pinned by
 * __tests__/agent-loop.test.ts "a watcher pause ends with a model reply and no
 * tool call".
 */
export async function* replyAfterWatcherPause(
  deps: StreamStepDeps,
  ctx: StreamStepContext,
  halt: HaltDecision,
  tierEscalationRef: { value?: string },
): AsyncGenerator<AgentEvent, WatcherPauseReply> {
  const note = `[The safety watcher paused this turn (rule: ${halt.rule}): ${halt.reason}. No tools are available for the rest of this turn. Reply to the user now: say what was done so far, that the turn was paused, and why.]`;
  const closing = yield* streamStep(
    { ...deps, tools: new DefaultToolRegistry() },
    { ...ctx, systemPrompt: ctx.systemPrompt ? `${ctx.systemPrompt}\n\n${note}` : note },
    tierEscalationRef,
  );

  // streamStep has already yielded the `error` event and persisted any partial
  // text; drain the usage rollup the way the loop's own fatal exit does.
  if (closing.outcome === 'fatal') {
    await flushTurnUsage(deps.session, ctx.sessionId, deps.turnUsage, deps.observability);
    return { fatal: true };
  }
  // Not retried: the halt event has already told the user why the turn stopped.
  if (closing.outcome === 'overflow') return { fatal: false, textDelta: '', turns: 0 };

  // A model that calls a tool it was not offered: streamStep has persisted the
  // tool_use blocks, so each gets an is_error tool_result and nothing runs.
  if (closing.outcome === 'tool-calls') {
    await persistAbortedToolCalls(
      deps.session,
      ctx.sessionId,
      ctx.traceId,
      closing.completedToolCalls,
      `Not run: the safety watcher paused this turn (${halt.rule}).`,
    );
  }
  return { fatal: false, textDelta: closing.fullTextDelta, turns: 1 };
}
