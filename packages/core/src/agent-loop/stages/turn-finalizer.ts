import type { AgentEvent, DryRunToolPlan, HookRegistry, SessionStore } from '@ethosagent/types';
import type { AgentLoopObservability } from '../../observability/agent-loop-observability';

export interface TurnFinalizerContext {
  sessionId: string;
  traceId: string | undefined;
  personalityId: string;
  allowedPlugins: string[];
  fullText: string;
  turnCount: number;
  successfulToolCalls: number;
  totalToolCalls: number;
  toolNames: string[];
  initialPrompt: string;
  activeSkillFiles: string[] | undefined;
  dryRunPlan: DryRunToolPlan[];
  dryRunCapped: number;
  isDryRun: boolean;
}

export async function* finalizeTurn(
  session: SessionStore,
  hooks: HookRegistry,
  observability: AgentLoopObservability | undefined,
  ctx: TurnFinalizerContext,
): AsyncGenerator<AgentEvent> {
  // Step 11: Update usage
  await session.updateUsage(ctx.sessionId, { apiCallCount: ctx.turnCount });

  // Step 12: Fire agent_done hook
  await hooks.fireVoid(
    'agent_done',
    {
      sessionId: ctx.sessionId,
      text: ctx.fullText,
      turnCount: ctx.turnCount,
      personalityId: ctx.personalityId,
      successfulToolCalls: ctx.successfulToolCalls,
      totalToolCalls: ctx.totalToolCalls,
      toolNames: ctx.toolNames,
      initialPrompt: ctx.initialPrompt,
      activeSkillFiles: ctx.activeSkillFiles,
    },
    ctx.allowedPlugins,
  );

  if (ctx.traceId) observability?.endTrace(ctx.traceId, 'ok');
  observability?.flush();

  yield { type: 'done', text: ctx.fullText, turnCount: ctx.turnCount };

  // dry_run_summary comes AFTER done — ordering preserved
  if (ctx.isDryRun && ctx.dryRunPlan.length > 0) {
    yield {
      type: 'dry_run_summary' as const,
      plan: ctx.dryRunPlan,
      capped: ctx.dryRunCapped,
    };
  }
}
