import type { PersonalityConfig, RedactionKit, ToolResult } from '@ethosagent/types';
import type { AgentLoopObservability } from '../../observability/agent-loop-observability';

export interface ResultRedactionDeps {
  redaction: RedactionKit;
  observability?: AgentLoopObservability;
}

export interface ResultRedactionContext {
  personality: PersonalityConfig;
  traceId: string | undefined;
}

/**
 * Secret detection + redaction for one executed tool result — BOTH variants:
 * `value` when `ok`, `error` when not (a failed HTTP call that echoes its
 * request URL carries the API key in `error`). Detections record a
 * `secret_in_tool_result` safety event; unless the personality sets
 * `safety.injectionDefense.blockSecretResults: false` (S9, default block), the
 * detected text is replaced via `redaction.redactString`.
 *
 * Callers run this immediately after the result resolves and BEFORE anything
 * else sees it — `tool_end`, `after_tool_call`, spans, memory telemetry, the
 * LLM-bound copy — so every downstream reader gets the same, redacted result:
 * `processTools` (./tool-processing.ts) for batch calls and
 * `ScriptToolBridge.dispatch` (./script-tool-bridge.ts) for in-script calls.
 * Pinned by `__tests__/tool-processing-redaction.test.ts`. Idempotent, so the
 * outer `run_code` result being redacted again by the batch path is harmless.
 */
export function redactToolResultSecrets(
  result: ToolResult,
  deps: ResultRedactionDeps,
  ctx: ResultRedactionContext,
): ToolResult {
  const text = result.ok ? result.value : result.error;
  if (!text) return result;
  const detections = deps.redaction.detectSecrets(text);
  if (detections.length === 0) return result;
  deps.observability?.recordSafetyBlock({
    traceId: ctx.traceId,
    code: 'secret_in_tool_result',
    cause: detections.map((d) => d.label).join(', '),
  });
  // S9 — secret-result blocking is ON by default. Unset (undefined) blocks; an
  // explicit `false` opts out (emit-only).
  if (!(ctx.personality.safety?.injectionDefense?.blockSecretResults ?? true)) return result;
  const redacted = deps.redaction.redactString(text);
  return result.ok ? { ...result, value: redacted } : { ...result, error: redacted };
}
