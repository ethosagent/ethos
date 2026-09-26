import { describeChatError } from '@ethosagent/surface-kit';
import type { ChatError } from '../../lib/chat-reducer';

// A3 (ux-feedback plan) — the one chat error banner. Wording comes from the
// shared `describeChatError` map in `@ethosagent/surface-kit` (plan rule 1:
// one chat-error map; no renderer carries its own copy): `✗ {title}`,
// `→ {action}`, `trace <id>` when the turn's `run_start` carried one. A
// Dismiss always; a Retry only when the map says a plain retry is worth
// offering. DESIGN.md voice rules: concrete, glyph + word, buttons are verbs.

export interface ChatErrorBannerProps {
  error: ChatError;
  /** Dispatches `clear-error`. */
  onDismiss: () => void;
  /** Re-runs the failed turn. Rendered only when the code is retryable. */
  onRetry?: () => void;
}

export function ChatErrorBanner({ error, onDismiss, onRetry }: ChatErrorBannerProps) {
  const described = describeChatError(error.code ?? '', error.message, error.traceId);
  return (
    <div className="chat-error" role="alert">
      <div className="chat-error-title">✗ {described.title}</div>
      <div className="chat-error-action">→ {described.action}</div>
      {described.trace ? <div className="chat-error-trace">trace {described.trace}</div> : null}
      <div className="chat-error-controls">
        {described.retryable && onRetry ? (
          <button type="button" className="chat-error-btn" onClick={onRetry}>
            Retry
          </button>
        ) : null}
        <button type="button" className="chat-error-btn" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
