import type { AgentEvent } from '@ethosagent/types';
import type { WatcherTap } from '../turn-context';

// §4 (profile-gated remainder) — presence check for a REPAIRED tool call's
// required fields. A repair signals the model emitted malformed output, so a
// structurally-valid-but-incomplete repair (missing a required top-level key)
// must not execute with holes. Clean strict-parse args are never routed here.
// Only checks top-level presence (per §4 scope) — no deep type validation.
// Returns the missing required keys (empty when nothing is required or the
// args are not a plain object).
export function missingRequiredFields(schema: Record<string, unknown>, args: unknown): string[] {
  const required = schema.required;
  if (!Array.isArray(required) || required.length === 0) return [];
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return [];
  const obj = args as Record<string, unknown>;
  const missing: string[] = [];
  for (const key of required) {
    if (typeof key !== 'string') continue;
    if (!(key in obj) || obj[key] === undefined) missing.push(key);
  }
  return missing;
}

// Emit the standard rejection signal for a tool call that will not execute:
// notify the watcher and yield an is_error tool_end. Callers still push the
// corresponding Prepped `{ rejected }` entry so the LLM receives a matching
// is_error tool_result (Anthropic tool_use/tool_result contract).
export function* emitToolRejection(
  observe: WatcherTap['observe'],
  toolCallId: string,
  toolName: string,
  reason: string,
): Generator<AgentEvent> {
  observe({ type: 'tool_end', toolName, ok: false });
  yield {
    type: 'tool_end',
    toolCallId,
    toolName,
    ok: false,
    durationMs: 0,
    result: reason,
    error: reason,
  };
}
