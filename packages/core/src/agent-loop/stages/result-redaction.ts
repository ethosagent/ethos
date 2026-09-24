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

/** `structured` nested deeper than this many levels is not walked. */
export const MAX_STRUCTURED_DEPTH = 64;
/** Stands in for a cyclic or too-deep `structured` subtree. */
export const UNSCANNABLE_MARKER = '[REDACTED:unscannable]';

/**
 * Secret detection + redaction for one executed tool result — every text it
 * carries: `value` when `ok`, `error` when not (a failed HTTP call that echoes
 * its request URL carries the API key in `error`), and every string leaf of
 * `structured` when `ok`. Plain objects and arrays inside `structured` are
 * walked; every other leaf passes through as it is. Detections record ONE
 * `secret_in_tool_result` safety event per result, however many places the
 * secret appears in; unless the personality sets
 * `safety.injectionDefense.blockSecretResults: false` (S9, default block), the
 * detected text is replaced via `redaction.redactString`. A rewritten
 * `structured` is a fresh copy; the tool's own object is never mutated.
 *
 * `structured` fails closed on what cannot be scanned: a cycle, or nesting
 * deeper than `MAX_STRUCTURED_DEPTH`, becomes `UNSCANNABLE_MARKER` whatever
 * `blockSecretResults` says, because an unscanned subtree is not known to be
 * secret-free. Known limitation: object KEYS are not scanned.
 *
 * Callers run this immediately after a result resolves and BEFORE anything
 * else sees it, exactly once per result, so every downstream reader gets the
 * same redacted result:
 *   - `processTools` (./tool-processing.ts) maps it over the batch's results
 *     right where `execResults` resolves — ahead of the returnDirect early exit
 *     (sibling `tool_end`s, `persistReturnDirect`, `done.text`), memory
 *     telemetry, spans, `tool_end` (including `tool_end.structured`),
 *     `after_tool_call` and the LLM-bound copy.
 *     Its `Tool result missing` fallback, built later for a call the registry
 *     lost, takes the same helper at construction.
 *   - `ScriptToolBridge.dispatch` (./script-tool-bridge.ts) for in-script calls,
 *     before the inner `tool_end` and the script see the result.
 * Pinned by `__tests__/tool-processing-redaction.test.ts`. Redaction output is
 * not re-detected, so the outer `run_code` result passing the batch site after
 * its inner calls passed the bridge is harmless.
 */
export function redactToolResultSecrets(
  result: ToolResult,
  deps: ResultRedactionDeps,
  ctx: ResultRedactionContext,
): ToolResult {
  const text = result.ok ? result.value : result.error;
  const labels = text ? deps.redaction.detectSecrets(text).map((d) => d.label) : [];
  const textHasSecret = labels.length > 0;
  const structured = result.ok ? result.structured : undefined;
  const scan = structured
    ? scanStructured(structured, (s) => deps.redaction.detectSecrets(s))
    : null;
  for (const label of scan?.labels ?? []) if (!labels.includes(label)) labels.push(label);

  if (labels.length > 0) {
    deps.observability?.recordSafetyBlock({
      traceId: ctx.traceId,
      code: 'secret_in_tool_result',
      cause: labels.join(', '),
    });
  }
  // S9 — secret-result blocking is ON by default. Unset (undefined) blocks; an
  // explicit `false` opts out (emit-only).
  const block =
    labels.length > 0 && (ctx.personality.safety?.injectionDefense?.blockSecretResults ?? true);
  const redactLeaves = block && (scan?.labels.length ?? 0) > 0;
  const rewriteStructured = redactLeaves || scan?.unscannable === true;
  if (!(block && textHasSecret) && !rewriteStructured) return result;

  if (!result.ok) return { ...result, error: deps.redaction.redactString(result.error) };
  return {
    ...result,
    ...(block && textHasSecret ? { value: deps.redaction.redactString(result.value) } : {}),
    ...(rewriteStructured && structured
      ? {
          structured: copyStructured(
            structured,
            redactLeaves ? (s) => deps.redaction.redactString(s) : null,
            0,
            new Set(),
          ) as Record<string, unknown>,
        }
      : {}),
  };
}

function isWalkable(v: unknown): v is Record<string, unknown> | unknown[] {
  if (Array.isArray(v)) return true;
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Detection labels over every string leaf, and whether any subtree was unscannable. */
function scanStructured(
  root: Record<string, unknown>,
  detect: RedactionKit['detectSecrets'],
): { labels: string[]; unscannable: boolean } {
  const labels: string[] = [];
  let unscannable = false;
  // Ancestors of the node being visited — a shared (DAG) reference is not a cycle.
  const onPath = new Set<object>();
  const visit = (v: unknown, depth: number): void => {
    if (typeof v === 'string') {
      for (const d of detect(v)) if (!labels.includes(d.label)) labels.push(d.label);
      return;
    }
    if (!isWalkable(v)) return;
    if (depth > MAX_STRUCTURED_DEPTH || onPath.has(v)) {
      unscannable = true;
      return;
    }
    onPath.add(v);
    for (const c of Array.isArray(v) ? v : Object.values(v)) visit(c, depth + 1);
    onPath.delete(v);
  };
  visit(root, 0);
  return { labels, unscannable };
}

/** A fresh copy of `v`, string leaves passed through `redact` when given. */
function copyStructured(
  v: unknown,
  redact: ((s: string) => string) | null,
  depth: number,
  onPath: Set<object>,
): unknown {
  if (typeof v === 'string') return redact ? redact(v) : v;
  if (!isWalkable(v)) return v;
  if (depth > MAX_STRUCTURED_DEPTH || onPath.has(v)) return UNSCANNABLE_MARKER;
  onPath.add(v);
  let out: unknown;
  if (Array.isArray(v)) {
    out = v.map((c) => copyStructured(c, redact, depth + 1, onPath));
  } else {
    const obj: Record<string, unknown> = {};
    for (const [k, c] of Object.entries(v)) {
      // defineProperty, not `obj[k] =`: an own `__proto__` key (JSON.parse
      // makes one) must stay a key, not replace the copy's prototype.
      Object.defineProperty(obj, k, {
        value: copyStructured(c, redact, depth + 1, onPath),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    out = obj;
  }
  onPath.delete(v);
  return out;
}
