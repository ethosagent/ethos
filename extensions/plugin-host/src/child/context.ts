import type { Storage, ToolContext, ToolExecuteRequest } from '@ethosagent/types';
import type { HostConnection } from '../connection';
import type { CallHandle } from '../protocol';
import { IpcStorage } from './ipc-storage';

/**
 * The request comes from our own parent, not a third party, but a frame is still
 * checked for its required scalars before it is used.
 */
export function isToolExecuteRequest(raw: unknown): raw is ToolExecuteRequest {
  if (typeof raw !== 'object' || raw === null) return false;
  const r: Record<string, unknown> = { ...raw };
  return (
    typeof r.toolCallId === 'string' &&
    typeof r.name === 'string' &&
    typeof r.sessionId === 'string' &&
    typeof r.sessionKey === 'string' &&
    typeof r.platform === 'string' &&
    typeof r.workingDir === 'string' &&
    typeof r.currentTurn === 'number' &&
    typeof r.messageCount === 'number' &&
    typeof r.resultBudgetChars === 'number'
  );
}

/**
 * Rebuilds a `ToolContext` in the child from the wire request (the same
 * field-by-field copy as `LocalToolTransport.executeWithLive`), plus reverse
 * stubs for the live half (plan §5.6). Only `abortSignal`, `emit` and `storage`
 * exist so far; the other reverse capabilities (llm, kv, secrets, fetch, fs,
 * attachments, context) are lane C / A2's and stay absent, so a tool that needs
 * one sees `undefined` exactly as it does behind a non-local transport.
 */
export function buildChildContext(
  request: ToolExecuteRequest,
  call: CallHandle,
  signal: AbortSignal,
  conn: HostConnection,
): ToolContext {
  const storage: Storage = new IpcStorage((op, args) =>
    conn.request('ethos/capability.storage', { call, op, args }),
  );
  return {
    toolCallId: request.toolCallId,
    sessionId: request.sessionId,
    sessionKey: request.sessionKey,
    platform: request.platform,
    workingDir: request.workingDir,
    personalityId: request.personalityId,
    teamId: request.teamId,
    agentId: request.agentId,
    rootSessionKey: request.rootSessionKey,
    jobId: request.jobId,
    ...(request.reviewOfJobId !== undefined ? { reviewOfJobId: request.reviewOfJobId } : {}),
    ...(request.roomAudience !== undefined ? { roomAudience: request.roomAudience } : {}),
    ...(request.initiator !== undefined ? { initiator: request.initiator } : {}),
    ...(request.toolsetNarrowing ? { toolsetNarrowing: request.toolsetNarrowing } : {}),
    origin: request.origin,
    memoryScopeId: request.memoryScopeId,
    userScopeId: request.userScopeId,
    currentTurn: request.currentTurn,
    messageCount: request.messageCount,
    resultBudgetChars: request.resultBudgetChars,
    networkPolicy: request.networkPolicy,
    dryRun: request.dryRun,
    abortSignal: signal,
    emit: (event) => conn.notify('ethos/emit', { call, event }),
    storage,
  };
}
