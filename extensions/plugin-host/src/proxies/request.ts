import type { ToolContext, ToolExecuteRequest } from '@ethosagent/types';

/**
 * The wire half of a `ToolContext` (the 21 `ToolExecuteRequest` fields), read
 * back off the parent's live context. The inverse of what
 * `LocalToolTransport.executeWithLive` copies in.
 */
export function requestFromContext(
  name: string,
  args: unknown,
  ctx: ToolContext,
): ToolExecuteRequest {
  return {
    toolCallId: ctx.toolCallId ?? '',
    name,
    args,
    sessionId: ctx.sessionId,
    sessionKey: ctx.sessionKey,
    platform: ctx.platform,
    workingDir: ctx.workingDir,
    personalityId: ctx.personalityId,
    teamId: ctx.teamId,
    agentId: ctx.agentId,
    rootSessionKey: ctx.rootSessionKey,
    jobId: ctx.jobId,
    reviewOfJobId: ctx.reviewOfJobId,
    roomAudience: ctx.roomAudience,
    initiator: ctx.initiator,
    toolsetNarrowing: ctx.toolsetNarrowing,
    origin: ctx.origin,
    memoryScopeId: ctx.memoryScopeId,
    userScopeId: ctx.userScopeId,
    currentTurn: ctx.currentTurn,
    messageCount: ctx.messageCount,
    resultBudgetChars: ctx.resultBudgetChars,
    networkPolicy: ctx.networkPolicy,
    dryRun: ctx.dryRun,
  };
}
