import type { ToolResult } from '@ethosagent/types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A host's answer is untrusted input: rebuild a `ToolResult` from the fields we
 * know instead of casting. Returns null when the shape is wrong.
 */
export function parseToolResult(raw: unknown): ToolResult | null {
  if (!isRecord(raw)) return null;
  if (raw.ok === true) {
    if (typeof raw.value !== 'string') return null;
    const out: ToolResult = { ok: true, value: raw.value };
    if (isRecord(raw.structured)) out.structured = raw.structured;
    if (typeof raw.cost_usd === 'number') out.cost_usd = raw.cost_usd;
    return out;
  }
  if (raw.ok !== false || typeof raw.error !== 'string') return null;
  switch (raw.code) {
    case 'input_invalid':
      return {
        ok: false,
        code: 'input_invalid',
        error: raw.error,
        ...(typeof raw.field === 'string' ? { field: raw.field } : {}),
      };
    case 'not_available':
      return {
        ok: false,
        code: 'not_available',
        error: raw.error,
        ...(typeof raw.reason === 'string' ? { reason: raw.reason } : {}),
      };
    case 'STALE_WRITE':
      return {
        ok: false,
        code: 'STALE_WRITE',
        error: raw.error,
        ...(typeof raw.conflictKey === 'string' ? { conflictKey: raw.conflictKey } : {}),
      };
    default:
      return { ok: false, code: 'execution_failed', error: raw.error };
  }
}

export function failure(code: 'execution_failed' | 'not_available', error: string): ToolResult {
  return { ok: false, code, error };
}
