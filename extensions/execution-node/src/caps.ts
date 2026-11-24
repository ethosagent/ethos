/**
 * Size and time limits shared by the guard, the proxy and the client (plan laptop-tool-node §4
 * Output and Replay rows). Not re-exported from index.ts: only the execution-node modules and
 * their tests use them. Pinned by __tests__/node-proxy.test.ts and __tests__/node-client.test.ts.
 */
import type { ToolResult } from '@ethosagent/types';

export const NODE_RESULT_CAP_CHARS = 64 * 1024;
export const NODE_PROGRESS_CAP_CHARS = 4096;
const STRUCTURED_MAX_BYTES = 16 * 1024;

/** How long a local approval prompt may stay open (D9). */
export const NODE_APPROVAL_TIMEOUT_MS = 300_000;
/** Longest `terminal` tool timeout. */
export const NODE_TERMINAL_MAX_MS = 600_000;
/** Longest a call can legitimately run: the longest tool plus a full approval wait (15 min). */
export const NODE_MAX_CALL_MS = NODE_TERMINAL_MAX_MS + NODE_APPROVAL_TIMEOUT_MS;
/** A call's deadline may not be further ahead than `NODE_MAX_CALL_MS` plus this. */
export const NODE_DEADLINE_GRACE_MS = 60_000;

/** Cuts a node-supplied string to `cap` chars (progress and free-text fields). */
function capNodeText(s: string, cap: number): string {
  return s.length > cap ? `${s.slice(0, cap)}\n[truncated — ${s.length} chars total]` : s;
}

/** Progress text is cut to `NODE_PROGRESS_CAP_CHARS` on both ends. */
export function capProgress(message: string): string {
  return message.slice(0, NODE_PROGRESS_CAP_CHARS);
}

function jsonBytes(v: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(v));
  } catch {
    // Not serialisable: treat as too large so it is dropped.
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Bounds a `ToolResult` that crossed the node boundary (either end). Free text is cut to
 * `min(budgetChars, 64 KiB)`, `cause` and `cost_usd` are always dropped, and `structured` is kept
 * only when <= 16 KiB. Pinned by node-proxy.test.ts and node-client.test.ts.
 */
export function capNodeResult(result: ToolResult, budgetChars: number): ToolResult {
  const cap = Math.max(0, Math.min(budgetChars, NODE_RESULT_CAP_CHARS));
  const cut = (s: string) => capNodeText(s, cap);
  if (result.ok) {
    const out: Extract<ToolResult, { ok: true }> = { ok: true, value: cut(result.value) };
    if (result.structured !== undefined && jsonBytes(result.structured) <= STRUCTURED_MAX_BYTES) {
      out.structured = result.structured;
    }
    return out;
  }
  switch (result.code) {
    case 'input_invalid':
      return result.field === undefined
        ? { ok: false, code: result.code, error: cut(result.error) }
        : { ok: false, code: result.code, error: cut(result.error), field: cut(result.field) };
    case 'not_available':
      return result.reason === undefined
        ? { ok: false, code: result.code, error: cut(result.error) }
        : { ok: false, code: result.code, error: cut(result.error), reason: cut(result.reason) };
    case 'execution_failed':
      return { ok: false, code: result.code, error: cut(result.error) };
    case 'STALE_WRITE':
      return result.conflictKey === undefined
        ? { ok: false, code: result.code, error: cut(result.error) }
        : {
            ok: false,
            code: result.code,
            error: cut(result.error),
            conflictKey: cut(result.conflictKey),
          };
  }
}
