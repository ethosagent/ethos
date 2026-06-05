import { useCallback, useEffect, useRef, useState } from 'react';
import { SlashCommandPopover } from './SlashCommandPopover';
import type { AttachmentPreview } from './types';

interface ComposerProps {
  onSend: (text: string) => void;
  onAbort: () => void;
  streaming: boolean;
  personalityName?: string;
  steerMode?: boolean;
  attachments?: AttachmentPreview[];
  onAttach?: (files: File[]) => void;
  onRemoveAttachment?: (localId: string) => void;
}

export function Composer({
  onSend,
  onAbort,
  streaming,
  personalityName,
  steerMode,
  attachments,
  onAttach,
  onRemoveAttachment,
}: ComposerProps) {
  const [text, setText] = useState('');
  const [showSlash, setShowSlash] = useState(false);
  const [slashFilter, setSlashFilter] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  const hasAttachments = (attachments?.length ?? 0) > 0;

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if ((!trimmed && !hasAttachments) || (!steerMode && streaming)) return;
    onSend(trimmed);
    setText('');
  }, [text, streaming, steerMode, onSend, hasAttachments]);

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = Array.from(e.clipboardData.items);
      const imageFiles = items
        .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
        .map((item) => item.getAsFile())
        .filter((f): f is File => f !== null);
      if (imageFiles.length > 0) {
        e.preventDefault();
        onAttach?.(imageFiles);
      }
    },
    [onAttach],
  );

  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      if (files.length > 0) onAttach?.(files);
      e.target.value = '';
    },
    [onAttach],
  );

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

      <input
        ref={fileInputRef}
        type="file"
        multiple
        onChange={handleFileInputChange}
        style={{ display: 'none' }}
      />

      {attachments && attachments.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', padding: '6px 0 4px' }}>
          {attachments.map((a) => (
            <div
              key={a.localId}
              style={{
                position: 'relative',
                borderRadius: 'var(--radius-sm)',
                overflow: 'hidden',
                background: 'var(--bg-overlay)',
              }}
            >
              {a.type === 'image' && a.previewUrl ? (
                <img
                  src={a.previewUrl}
                  alt={a.name}
                  style={{
                    width: 48,
                    height: 48,
                    objectFit: 'cover',
                    display: 'block',
                  }}
                />
              ) : (
                <span
                  style={{
                    display: 'block',
                    padding: '6px 8px',
                    fontSize: 11,
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--text-secondary)',
                    maxWidth: 120,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {a.name}
                </span>
              )}
              <button
                type="button"
                onClick={() => onRemoveAttachment?.(a.localId)}
                aria-label="Remove"
                style={{
                  position: 'absolute',
                  top: 2,
                  right: 2,
                  width: 14,
                  height: 14,
                  borderRadius: '50%',
                  background: 'var(--bg-base)',
                  border: 'none',
                  fontSize: 10,
                  cursor: 'pointer',
                  color: 'var(--text-secondary)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  lineHeight: 1,
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <textarea
        ref={textareaRef}
        value={text}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
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
          caretColor: 'var(--info)',
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            aria-label="Attach file"
            style={{
              width: 22,
              height: 22,
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--border-subtle)',
              background: 'none',
              color: 'var(--text-tertiary)',
              fontSize: 14,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              lineHeight: 1,
              padding: 0,
            }}
          >
            +
          </button>
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

        {streaming ? (
          <div style={{ display: 'flex', gap: 6 }}>
            {steerMode && (
              <button
                type="button"
                onClick={handleSend}
                disabled={!text.trim()}
                style={{
                  height: 28,
                  minWidth: 60,
                  borderRadius: 'var(--radius-sm)',
                  background: text.trim() ? 'var(--info)' : 'var(--bg-overlay)',
                  color: text.trim() ? '#ffffff' : 'var(--text-tertiary)',
                  border: 'none',
                  fontFamily: 'var(--font-display)',
                  fontSize: 13,
                  fontWeight: 500,
                  cursor: text.trim() ? 'pointer' : 'default',
                  opacity: text.trim() ? 1 : 0.5,
                }}
              >
                Steer
              </button>
            )}
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
          </div>
        ) : (
          <button
            type="button"
            onClick={handleSend}
            disabled={!text.trim() && !hasAttachments}
            style={{
              height: 28,
              minWidth: 60,
              borderRadius: 'var(--radius-sm)',
              background: text.trim() || hasAttachments ? 'var(--info)' : 'var(--bg-overlay)',
              color: text.trim() || hasAttachments ? '#ffffff' : 'var(--text-tertiary)',
              border: 'none',
              fontFamily: 'var(--font-display)',
              fontSize: 13,
              fontWeight: 500,
              cursor: text.trim() || hasAttachments ? 'pointer' : 'default',
              opacity: text.trim() || hasAttachments ? 1 : 0.5,
            }}
          >
            Send
          </button>
        )}
      </div>
    </div>
  );
}
