import { ScopedProcessImpl } from '@ethosagent/core';
import type {
  Attachment,
  Storage,
  ToolCapabilities,
  ToolContext,
  ToolExecuteRequest,
} from '@ethosagent/types';
import type { HostConnection } from '../connection';
import type { CallHandle, LiveSnapshot } from '../protocol';
import { isRecord } from '../util';
import { ipcAttachments, ipcFetch, ipcFs, ipcKv, ipcLlm, ipcSecretsResolver } from './ipc-caps';
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

export function parseLiveSnapshot(raw: unknown): LiveSnapshot {
  if (!isRecord(raw)) return { llm: false, context: false };
  return {
    llm: raw.llm === true,
    context: raw.context === true,
    ...(Array.isArray(raw.attachments) ? { attachments: raw.attachments } : {}),
  };
}

function attachmentsOf(snapshot: LiveSnapshot): Attachment[] {
  const out: Attachment[] = [];
  for (const a of snapshot.attachments ?? []) {
    if (
      isRecord(a) &&
      (a.type === 'image' || a.type === 'file' || a.type === 'audio') &&
      typeof a.ref === 'string' &&
      typeof a.url === 'string' &&
      typeof a.mimeType === 'string'
    ) {
      out.push({
        type: a.type,
        ref: a.ref,
        url: a.url,
        mimeType: a.mimeType,
        ...(typeof a.filename === 'string' ? { filename: a.filename } : {}),
        ...(typeof a.sizeBytes === 'number' ? { sizeBytes: a.sizeBytes } : {}),
      });
    }
  }
  return out;
}

/** The call-scoped `Storage` stub every hosted call (tool, slash, CLI) gets. */
export function ipcStorageFor(conn: HostConnection, call: CallHandle): Storage {
  return new IpcStorage((op, args) => conn.request('ethos/capability.storage', { call, op, args }));
}

/**
 * Rebuilds a `ToolContext` in the child from the wire request (the same
 * field-by-field copy as `LocalToolTransport.executeWithLive`), plus reverse
 * stubs for the live and derived half (plan §5.6). Derived handles follow the
 * tool's DECLARED capabilities, exactly as the in-process transport resolves
 * them, so an undeclared one is absent. `getContext`/`setContext`,
 * `readMtimes`, `a2aDelegation` and `scriptTools` are absent: the first two are
 * synchronous and cannot cross a pipe; the others are live object identity.
 */
export function buildChildContext(
  request: ToolExecuteRequest,
  call: CallHandle,
  signal: AbortSignal,
  conn: HostConnection,
  caps: ToolCapabilities,
  live: LiveSnapshot,
): ToolContext {
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
    storage: ipcStorageFor(conn, call),
    ...(live.llm ? { llm: ipcLlm(conn, call) } : {}),
    ...(caps.storage ? { kvStore: ipcKv(conn, call) } : {}),
    ...(caps.secrets && caps.secrets.length > 0
      ? { secretsResolver: ipcSecretsResolver(conn, call) }
      : {}),
    ...(caps.network ? { scopedFetch: ipcFetch(conn, call) } : {}),
    ...(caps.fs_reach ? { scopedFs: ipcFs(conn, call) } : {}),
    ...(caps.attachments ? { attachments: ipcAttachments(conn, call, attachmentsOf(live)) } : {}),
    // Host-local (D20): subprocesses inherit the host's env and sandbox, not the parent's.
    ...(caps.process
      ? { scopedProcess: new ScopedProcessImpl(new Set(caps.process.allowedBinaries)) }
      : {}),
  };
}
