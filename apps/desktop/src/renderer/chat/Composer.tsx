import { useCallback, useEffect, useRef, useState } from 'react';
import { SlashCommandPopover } from './SlashCommandPopover';

interface ComposerProps {
  onSend: (text: string) => void;
  onAbort: () => void;
  streaming: boolean;
  personalityName?: string;
}

export function Composer({ onSend, onAbort, streaming, personalityName }: ComposerProps) {
  const [text, setText] = useState('');
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
    if (!trimmed || streaming) return;
    onSend(trimmed);
    setText('');
  }, [text, streaming, onSend]);

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

  const placeholder = personalityName ? `Message ${personalityName}...` : 'Message...';

  return (
    <div
      style={{
        position: 'relative',
        background: 'var(--bg-base)',
        borderTop: '1px solid var(--border-subtle)',
        padding: '10px 16px 8px',
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

      <textarea
        ref={textareaRef}
        value={text}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        rows={1}
        style={{
          width: '100%',
          resize: 'none',
          border: 'none',
          outline: 'none',
          background: 'var(--bg-base)',
          fontFamily: 'var(--font-display)',
          fontSize: 14,
          color: 'var(--text-primary)',
          lineHeight: '22px',
          padding: '6px 0',
        }}
      />

      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginTop: 4,
        }}
      >
        <span
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 12,
            color: 'var(--text-tertiary)',
          }}
        >
          / commands · Shift↵ new line
        </span>

        {streaming ? (
          <button
            type="button"
            onClick={onAbort}
            style={{
              height: 28,
              minWidth: 60,
              borderRadius: 'var(--radius-sm)',
              background: 'var(--accent)',
              color: 'var(--bg-base)',
              border: 'none',
              fontFamily: 'var(--font-display)',
              fontSize: 13,
              fontWeight: 500,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 4,
            }}
          >
            <span style={{ fontSize: 10 }}>■</span>
            Stop
          </button>
        ) : (
          <button
            type="button"
            onClick={handleSend}
            disabled={!text.trim()}
            style={{
              height: 28,
              minWidth: 60,
              borderRadius: 'var(--radius-sm)',
              background: text.trim() ? 'var(--accent)' : 'var(--bg-overlay)',
              color: text.trim() ? 'var(--bg-base)' : 'var(--text-tertiary)',
              border: 'none',
              fontFamily: 'var(--font-display)',
              fontSize: 13,
              fontWeight: 500,
              cursor: text.trim() ? 'pointer' : 'default',
              opacity: text.trim() ? 1 : 0.5,
            }}
          >
            Send
          </button>
        )}
      </div>
    </div>
  );
}
