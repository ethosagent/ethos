import { useCallback, useEffect, useRef, useState } from 'react';
import { SlashCommandPopover } from './SlashCommandPopover';

interface ComposerProps {
  onSend: (text: string) => void;
  onAbort: () => void;
  streaming: boolean;
  personalityName?: string;
  steerMode?: boolean;
}

export function Composer({
  onSend,
  onAbort,
  streaming,
  personalityName,
  steerMode,
}: ComposerProps) {
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  const [showSlash, setShowSlash] = useState(false);
  const [slashFilter, setSlashFilter] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const maxLines = 6;
    const lineHeight = 22;
    const maxH = maxLines * lineHeight + 16;
    el.style.height = `${Math.min(el.scrollHeight, maxH)}px`;
    el.style.overflowY = el.scrollHeight > maxH ? 'auto' : 'hidden';
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: text is an intentional trigger to recalculate height
  useEffect(() => {
    adjustHeight();
  }, [text, adjustHeight]);

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || (!steerMode && streaming)) return;
    onSend(trimmed);
    setText('');
  }, [text, streaming, steerMode, onSend]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
      if (e.key === 'Escape' && streaming) {
        onAbort();
      }
    },
    [handleSend, streaming, onAbort],
  );

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setText(val);

    if (val.startsWith('/') && !val.includes(' ') && !val.includes('\n')) {
      setShowSlash(true);
      setSlashFilter(val.slice(1));
    } else {
      setShowSlash(false);
      setSlashFilter('');
    }
  }, []);

  const handleSlashCommand = useCallback(
    (cmd: string) => {
      setShowSlash(false);
      setSlashFilter('');
      setText('');
      onSend(`/${cmd}`);
    },
    [onSend],
  );

  const handleSlashClose = useCallback(() => {
    setShowSlash(false);
    setSlashFilter('');
  }, []);

  const placeholder = steerMode
    ? 'Steer the agent...'
    : personalityName
      ? `Message ${personalityName}...`
      : 'Message...';

  const hasText = text.trim().length > 0;

  return (
    <div
      style={{
        position: 'relative',
        padding: '10px 16px 12px',
        background: 'var(--bg-base)',
      }}
    >
      {showSlash && (
        <div style={{ position: 'absolute', bottom: '100%', left: 16, right: 16, zIndex: 10 }}>
          <SlashCommandPopover
            onCommand={handleSlashCommand}
            onClose={handleSlashClose}
            filter={slashFilter}
          />
        </div>
      )}

      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: 8,
          background: 'var(--bg-elevated)',
          border: `1px solid ${focused ? 'var(--blue)' : 'var(--border-strong)'}`,
          borderRadius: 12,
          padding: '8px 8px 8px 14px',
          transition: 'border-color var(--motion-fast) var(--ease)',
        }}
      >
        <textarea
          ref={textareaRef}
          value={text}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={placeholder}
          rows={1}
          style={{
            flex: 1,
            resize: 'none',
            border: 'none',
            outline: 'none',
            background: 'transparent',
            fontFamily: 'var(--font-display)',
            fontSize: 14,
            color: 'var(--text-primary)',
            lineHeight: '22px',
            caretColor: 'var(--info)',
            padding: '4px 0',
          }}
        />

        {streaming ? (
          <div style={{ display: 'flex', gap: 6, flexShrink: 0, alignItems: 'center' }}>
            {steerMode && (
              <button
                type="button"
                onClick={handleSend}
                disabled={!hasText}
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: '50%',
                  background: hasText ? 'var(--info)' : 'var(--bg-overlay)',
                  color: hasText ? '#ffffff' : 'var(--text-tertiary)',
                  border: 'none',
                  cursor: hasText ? 'pointer' : 'default',
                  opacity: hasText ? 1 : 0.5,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 14,
                  flexShrink: 0,
                }}
                aria-label="Steer"
              >
                ↗
              </button>
            )}
            <button
              type="button"
              onClick={onAbort}
              style={{
                width: 32,
                height: 32,
                borderRadius: '50%',
                background: 'var(--accent)',
                color: 'var(--bg-base)',
                border: 'none',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 10,
                flexShrink: 0,
              }}
              aria-label="Stop"
            >
              ■
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={handleSend}
            disabled={!hasText}
            style={{
              width: 32,
              height: 32,
              borderRadius: '50%',
              background: hasText ? 'var(--info)' : 'var(--bg-overlay)',
              color: hasText ? '#ffffff' : 'var(--text-tertiary)',
              border: 'none',
              cursor: hasText ? 'pointer' : 'default',
              opacity: hasText ? 1 : 0.5,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              transition:
                'background var(--motion-fast) var(--ease), opacity var(--motion-fast) var(--ease)',
            }}
            aria-label="Send"
          >
            <svg
              aria-hidden="true"
              width={16}
              height={16}
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <title>Send</title>
              <path d="M8 14V2M8 2L3 7M8 2l5 5" />
            </svg>
          </button>
        )}
      </div>

      <div
        style={{
          display: 'flex',
          justifyContent: 'center',
          marginTop: 6,
        }}
      >
        <span
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 11,
            color: 'var(--text-tertiary)',
          }}
        >
          / commands · Shift↵ new line
        </span>
      </div>
    </div>
  );
}
