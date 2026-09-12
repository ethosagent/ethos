import { z } from 'zod';

// How the Memory page reads a failed memory RPC — `memory.list` for the Files
// tab, `memory.history` for the Timeline (F04). The server refuses both for a
// backend with no file memory: `MemoryService.requireEditing` throws
// NOT_CONFIGURED with the reason, which `routes/rpc.ts` forwards as the oRPC
// error's `code` / `message` / `data.action`. The page keys on THAT code, not on
// the config's `memory` mode: config.yaml can already name one backend while the
// running server still serves another (a change applies on restart).

/** The structured part of an oRPC client error. */
const RpcErrorSchema = z.object({ code: z.string(), message: z.string() });
const RpcErrorActionSchema = z.object({ data: z.object({ action: z.string() }) });

export type MemoryFailure =
  /** The running server's backend has no file editor (e.g. `memory: vector`). */
  | { kind: 'unsupported'; message: string; action?: string }
  /** Anything else — a transport or server failure. */
  | { kind: 'failed'; message: string };

export function memoryFailure(err: unknown): MemoryFailure {
  const parsed = RpcErrorSchema.safeParse(err);
  if (parsed.success && parsed.data.code === 'NOT_CONFIGURED') {
    const action = RpcErrorActionSchema.safeParse(err);
    return {
      kind: 'unsupported',
      message: parsed.data.message,
      ...(action.success ? { action: action.data.data.action } : {}),
    };
  }
  return { kind: 'failed', message: err instanceof Error ? err.message : String(err) };
}

/**
 * `retry` for a memory query: a refusal is an answer, not a flake, so it is
 * never re-sent; anything else retries once, the app-wide default
 * (`apps/web/src/main.tsx`).
 */
export function retryMemoryQuery(failureCount: number, err: unknown): boolean {
  if (memoryFailure(err).kind === 'unsupported') return false;
  return failureCount < 1;
}
