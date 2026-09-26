// ---------------------------------------------------------------------------
// A3 — the one chat-error map (plan/phases/ux-feedback-and-config-clarity.md §3.1).
//
// The single source of user-facing wording for turn errors: every `code` the
// agent loop yields on an `error` event maps to a title, a next step, and
// whether a plain retry is worth offering. CLI, TUI bridge, web reducer and
// gateway render from here; no renderer carries its own copy. Coverage is
// enforced by `__tests__/chat-error-map.test.ts`, which extracts the codes
// from the core sources and asserts each has an entry.
// ---------------------------------------------------------------------------

import { FALLBACK_ERROR_ACTION } from '@ethosagent/types';

export interface ChatErrorEntry {
  title: string;
  action: string;
  retryable: boolean;
}

export const CHAT_ERROR_MAP: Record<string, ChatErrorEntry> = {
  llm_error: {
    title: 'the model call failed',
    action: 'retry; if it repeats, check provider status and ~/.ethos/config.yaml',
    retryable: true,
  },
  context_overflow: {
    title: 'conversation too large for the model',
    action: 'run /compact to shrink history, or /new to start fresh',
    retryable: false,
  },
  compaction_summary_failed: {
    title: 'context compaction failed',
    action: 'run /compact again or /new to start fresh',
    retryable: false,
  },
  context_window_too_small: {
    title: 'prompt does not fit the model context window',
    action: 'run /new, or configure a model with a larger context window',
    retryable: false,
  },
  streaming_timeout: {
    title: 'the model stopped responding',
    action: 'retry; check your network connection',
    retryable: true,
  },
  model_unresolved: {
    title: 'no usable model configuration',
    action: 'check the model and providers entries in ~/.ethos/config.yaml',
    retryable: false,
  },
  aborted: {
    title: 'stopped',
    action: 'send a new message to continue',
    retryable: false,
  },
  rate_limited: {
    title: 'rate limited by the provider',
    action: 'wait a moment and retry',
    retryable: true,
  },
  personality_locked: {
    title: 'session is bound to another personality',
    action: 'start a new session with /new, or fork this one',
    retryable: false,
  },
  BUDGET_EXCEEDED: {
    title: 'session budget cap reached',
    action: 'run /budget reset to start a new budget window',
    retryable: false,
  },
  FS_REACH_INVALID: {
    title: 'personality has an unusable fs_reach',
    action: "fix fs_reach in the personality's config.yaml",
    retryable: false,
  },
};

export interface ChatErrorDescription {
  title: string;
  action: string;
  /** The turn's trace id, passed through for the renderer's `trace <id>` line. */
  trace?: string;
  retryable: boolean;
}

/**
 * Resolve a turn-error `code` to its user-facing wording. Watcher terminations
 * carry a dynamic code (`watcher_<rule>`, agent-loop.ts) and resolve by
 * prefix; unknown codes fall back to the raw message as the title with the
 * `FALLBACK_ERROR_ACTION` sentence from `@ethosagent/types`.
 */
export function describeChatError(
  code: string,
  raw: string,
  traceId?: string,
): ChatErrorDescription {
  const entry =
    CHAT_ERROR_MAP[code] ??
    (code.startsWith('watcher_')
      ? {
          title: `stopped by watcher (${code.slice('watcher_'.length)})`,
          action: 'review the watcher rule, or start a new session with /new',
          retryable: false,
        }
      : undefined);
  const described = entry ?? {
    title: raw.trim() || `error (${code})`,
    action: FALLBACK_ERROR_ACTION,
    retryable: false,
  };
  return traceId ? { ...described, trace: traceId } : { ...described };
}
