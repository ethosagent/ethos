import type { AgentEvent } from '@ethosagent/types';

// ---------------------------------------------------------------------------
// Typed AgentEvent translator
//
// Every surface that consumes `AgentLoop.run()`'s `AsyncIterable<AgentEvent>`
// performs the same fold: discriminate the union, accumulate assistant text,
// track tool-call lifecycle, sum usage, and latch the terminal `error`/`done`.
// This module captures that common fold once so surfaces keep only their own
// rendering (terminal ANSI, SSE frames, channel string) — not the
// discrimination/accumulation.
//
// It also exposes the tool-progress audience gate as a single predicate so no
// surface re-implements "should I surface this progress event to the user".
// Per the audience boundary (Phase 30.2), only `audience: 'user'` progress may
// reach the CLI / channel adapters; `'internal'` (and `'dashboard'`) must not.
// ---------------------------------------------------------------------------

export interface EventTranslatorUsage {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

export interface EventTranslatorError {
  error: string;
  code: string;
}

export interface EventTranslatorDone {
  text: string;
  turnCount: number;
}

export interface EventTranslatorHalt {
  kind: 'budget' | 'watcher';
  rule: string;
  toolName?: string;
  count?: number;
  message: string;
}

/** Per-call lifecycle state accumulated across `tool_start` → `tool_end`. */
export interface ToolCallState {
  toolCallId: string;
  toolName: string;
  /** `undefined` when a `tool_end` arrived without a preceding `tool_start`. */
  args: unknown;
  /** Wall-clock timestamp captured when the call was first observed. */
  startedAt: number;
  ended: boolean;
  ok?: boolean;
  durationMs?: number;
}

export interface EventTranslator {
  /** Fold one event into the accumulated state. Unknown/irrelevant event
   *  types are a no-op (forward-compat). */
  push(event: AgentEvent): void;
  /** Concatenated `text_delta` text, in arrival order. */
  readonly text: string;
  /** Running usage totals summed across every `usage` event. */
  readonly usage: EventTranslatorUsage;
  /** Latched on the first `error` event; `null` until then. */
  readonly error: EventTranslatorError | null;
  /** Latched on the first `done` event; `null` until then. */
  readonly done: EventTranslatorDone | null;
  /** Latched on the most recent `halt` event; `null` until then. */
  readonly halt: EventTranslatorHalt | null;
  /** `true` once a terminal `error` or `done` has been seen — surfaces that
   *  break out of the run loop test this. */
  readonly stopped: boolean;
  /** Tool-call lifecycle, keyed by `toolCallId`. */
  readonly tools: ReadonlyMap<string, ToolCallState>;
}

export interface EventTranslatorOptions {
  /** Clock used to stamp `ToolCallState.startedAt`. Defaults to `Date.now`.
   *  Injectable for deterministic tests. */
  now?: () => number;
}

/**
 * Create a stateful translator that folds `AgentEvent`s into accumulated
 * surface-agnostic state. See the module comment for the contract.
 */
export function createEventTranslator(options: EventTranslatorOptions = {}): EventTranslator {
  const now = options.now ?? Date.now;

  let text = '';
  const usage: EventTranslatorUsage = { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
  let error: EventTranslatorError | null = null;
  let done: EventTranslatorDone | null = null;
  let halt: EventTranslatorHalt | null = null;
  const tools = new Map<string, ToolCallState>();

  return {
    push(event: AgentEvent): void {
      switch (event.type) {
        case 'text_delta':
          text += event.text;
          break;
        case 'usage':
          usage.inputTokens += event.inputTokens;
          usage.outputTokens += event.outputTokens;
          usage.estimatedCostUsd += event.estimatedCostUsd;
          break;
        case 'tool_start':
          tools.set(event.toolCallId, {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.args,
            startedAt: now(),
            ended: false,
          });
          break;
        case 'tool_end': {
          const existing = tools.get(event.toolCallId);
          if (existing) {
            existing.ended = true;
            existing.ok = event.ok;
            existing.durationMs = event.durationMs;
          } else {
            tools.set(event.toolCallId, {
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              args: undefined,
              startedAt: now(),
              ended: true,
              ok: event.ok,
              durationMs: event.durationMs,
            });
          }
          break;
        }
        case 'error':
          if (error === null) error = { error: event.error, code: event.code };
          break;
        case 'done':
          if (done === null) done = { text: event.text, turnCount: event.turnCount };
          break;
        case 'halt':
          halt = {
            kind: event.kind,
            rule: event.rule,
            message: event.message,
            ...(event.toolName !== undefined ? { toolName: event.toolName } : {}),
            ...(event.count !== undefined ? { count: event.count } : {}),
          };
          break;
        default:
          // Forward-compat: AgentEvent may grow new variants in any release.
          // Unknown/irrelevant types are a no-op by design — do NOT add an
          // exhaustiveness assertion here.
          break;
      }
    },
    get text() {
      return text;
    },
    get usage() {
      return usage;
    },
    get error() {
      return error;
    },
    get done() {
      return done;
    },
    get halt() {
      return halt;
    },
    get stopped() {
      return error !== null || done !== null;
    },
    get tools() {
      return tools;
    },
  };
}

/**
 * The tool-progress audience gate, as a single reusable predicate. Returns
 * `true` only when a `tool_progress` event is meant for the end user. Surface
 * code (CLI chat, channel adapters) MUST NOT surface progress for which this
 * returns `false` — `'internal'` and `'dashboard'` progress stays framework-only.
 */
export function shouldSurfaceProgress(
  event: Extract<AgentEvent, { type: 'tool_progress' }>,
): boolean {
  return event.audience === 'user';
}
