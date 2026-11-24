/**
 * buildNodeExecutor — the laptop half of the node tools (plan laptop-tool-node D8/D17).
 *
 * Runs `read_file`/`write_file`/`patch_file`/`search_files` (+ `terminal` when allowed) over
 * `LocalToolTransport` directly. No DefaultToolRegistry: no allowlist or hook layer is wanted on
 * the node — `NodeGuard` (extensions/execution-node/src/node-guard.ts) is that layer.
 *
 * It constructs no raw fs: `ScopedFsImpl`'s documented carve-out is the only symlink walk.
 * Behaviour is pinned by packages/wiring/src/__tests__/node-executor.test.ts.
 */
import { type CapabilityBackends, LocalToolTransport } from '@ethosagent/core';
import { foldedInsideRoot, type NodeRoot } from '@ethosagent/execution-node';
import { sensitiveDenyPaths } from '@ethosagent/storage-fs';
import { createFileTools } from '@ethosagent/tools-file';
import { createTerminalTools } from '@ethosagent/tools-terminal';
import type {
  Storage,
  Tool,
  ToolExecuteRequest,
  ToolProgressEvent,
  ToolResult,
} from '@ethosagent/types';

const MTIME_SESSIONS_MAX = 64;

export interface NodeExecutorOptions {
  roots: NodeRoot[];
  allowTerminal: boolean;
  storage: Storage;
  stateDir: string;
}

export interface NodeExecutor {
  readonly toolNames: readonly string[];
  execute(
    request: ToolExecuteRequest,
    signal: AbortSignal,
    emit: (e: ToolProgressEvent) => void,
  ): Promise<ToolResult>;
}

/**
 * The reach every node tool call gets. The argument (the server's personalityId) is ignored on
 * purpose (plan D8); pinned by node-executor.test.ts "personalityFsReach returns the node roots".
 */
export function nodePersonalityFsReach(
  roots: readonly NodeRoot[],
): (personalityId?: string) => { read: string[]; write: string[] } {
  const read = roots.map((r) => r.path);
  const write = roots.filter((r) => !r.readOnly).map((r) => r.path);
  return () => ({ read: [...read], write: [...write] });
}

/**
 * Read-only roots that must also be write-denied: those nested inside (or beside) the writable
 * reach. `ScopedFsImpl.matchesAny` compares `foldForDeny` keys, so every case/NFC spelling is
 * refused (node-executor.test.ts "M1"). A read-only root that CONTAINS a writable root is
 * skipped: the write reach already excludes it, and denying it would block the carve-out.
 */
export function nodeWriteDeny(roots: readonly NodeRoot[]): string[] {
  const writable = roots.filter((r) => !r.readOnly).map((r) => r.path);
  return roots
    .filter((r) => r.readOnly && !writable.some((w) => foldedInsideRoot(w, r.path)))
    .map((r) => r.path);
}

export function buildNodeExecutor(opts: NodeExecutorOptions): NodeExecutor {
  const primary = opts.roots[0];
  if (!primary) throw new Error('buildNodeExecutor needs at least one root');

  const tools: Tool[] = [
    ...createFileTools(),
    ...(opts.allowTerminal ? createTerminalTools() : []),
  ];
  const byName = new Map(tools.map((t) => [t.name, t]));

  const writeDeny = nodeWriteDeny(opts.roots);
  const backends: CapabilityBackends = {
    storage: opts.storage,
    // Ignores its argument: the server's personalityId / fs_reach is never consulted
    // (plan D8), pinned by node-executor.test.ts "ignores the server personalityId".
    personalityFsReach: nodePersonalityFsReach(opts.roots),
    personalityFsWriteDeny: () => writeDeny,
    alwaysDenyPaths: sensitiveDenyPaths([opts.stateDir]),
    stateDirs: [opts.stateDir],
  };
  const transport = new LocalToolTransport((name) => byName.get(name), backends);
  // Stale-write bookkeeping is per session: one session's reads never vouch for another's patch.
  // Least-recently-used sessions are dropped beyond MTIME_SESSIONS_MAX.
  const mtimesBySession = new Map<string, Map<string, { mtimeMs: number; readAtTurn: number }>>();
  const mtimesFor = (sessionKey: string) => {
    const existing = mtimesBySession.get(sessionKey);
    mtimesBySession.delete(sessionKey);
    const map = existing ?? new Map<string, { mtimeMs: number; readAtTurn: number }>();
    mtimesBySession.set(sessionKey, map);
    if (mtimesBySession.size > MTIME_SESSIONS_MAX) {
      const oldest = mtimesBySession.keys().next().value;
      if (oldest !== undefined) mtimesBySession.delete(oldest);
    }
    return map;
  };

  return {
    toolNames: tools.map((t) => t.name),
    execute: (request, signal, emit) =>
      transport.executeWithLive({ ...request, workingDir: primary.path }, signal, {
        emit,
        readMtimes: mtimesFor(request.sessionKey),
      }),
  };
}
