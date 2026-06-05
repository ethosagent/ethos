import { personalityAccent } from '@ethosagent/design-tokens';
import { Input } from 'antd';
import { type KeyboardEvent, useState } from 'react';

// Sticky composer at the bottom of the chat surface. Three keyboard
// rules, all standard chat UX:
//   • Enter      → send (preventDefault — no newline).
//   • Shift+Enter → newline.
//   • Cmd/Ctrl+Enter → also send (the user-was-using-newlines path).
//
// The accent caret is the subtlest personality fingerprint in the
// product — `caret-color: var(--accent)` flows from the per-personality
// ConfigProvider wrapper above this component. People notice it without
// being able to say why.

export interface ComposerProps {
  personalityId: string;
  /** Disable the input + button while a turn is in flight. */
  disabled?: boolean;
  onSend: (text: string) => void | Promise<void>;
  /** Optional placeholder. Default mirrors the magic-moment prompt for
   *  empty sessions; pages override for already-active sessions. */
  placeholder?: string;
  isStreaming?: boolean;
  onAbort?: () => void;
}

export function Composer({
  personalityId,
  disabled,
  onSend,
  placeholder,
  isStreaming,
  onAbort,
}: ComposerProps) {
  const [text, setText] = useState('');
  const accent = personalityAccent(personalityId);

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    setText('');
    void onSend(trimmed);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter') return;
    if (e.shiftKey) return; // newline — let the textarea handle it
    e.preventDefault();
    handleSend();
  };

  return (
    <div className="composer">
      <div className="composer-inner">
        <div className="composer-card">
          <Input.TextArea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder ?? 'Send a message…'}
            autoSize={{ minRows: 1, maxRows: 8 }}
            style={{ caretColor: accent, fontSize: 14, lineHeight: 1.5 }}
            disabled={disabled}
          />
          {isStreaming && onAbort ? (
            <button
              type="button"
              className="composer-send-btn composer-stop-btn"
              onClick={onAbort}
              aria-label="Stop"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                <rect x="2" y="2" width="10" height="10" rx="1.5" fill="white" />
              </svg>
            </button>
          ) : (
            <button
              type="button"
              className="composer-send-btn"
              onClick={handleSend}
              disabled={disabled || text.trim() === ''}
              aria-label="Send message"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M3 8h10M9 4l4 4-4 4"
                  stroke="white"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
