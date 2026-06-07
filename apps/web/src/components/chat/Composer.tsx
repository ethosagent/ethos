import { personalityAccent } from '@ethosagent/design-tokens';
import { Input } from 'antd';
import { type KeyboardEvent, useRef, useState } from 'react';
import type { AttachmentPreview } from '../../lib/attachments';

export interface ComposerProps {
  personalityId: string;
  disabled?: boolean;
  onSend: (text: string) => void | Promise<void>;
  placeholder?: string;
  isStreaming?: boolean;
  onAbort?: () => void;
  attachments?: AttachmentPreview[];
  onAttach?: (files: File[]) => void;
  onRemoveAttachment?: (localId: string) => void;
}

export function Composer({
  personalityId,
  disabled,
  onSend,
  placeholder,
  isStreaming,
  onAbort,
  attachments,
  onAttach,
  onRemoveAttachment,
}: ComposerProps) {
  const [text, setText] = useState('');
  const accent = personalityAccent(personalityId);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const hasReadyAttachments = attachments && attachments.length > 0;
  const isUploading = attachments?.some((a) => a.state === 'uploading');

  const handleSend = () => {
    const trimmed = text.trim();
    if ((!trimmed && !hasReadyAttachments) || disabled || isUploading) return;
    setText('');
    void onSend(trimmed);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter') return;
    if (e.shiftKey) return;
    e.preventDefault();
    handleSend();
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items || !onAttach) return;
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item?.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      onAttach(files);
    }
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!onAttach) return;
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) onAttach(files);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!onAttach || !e.target.files) return;
    onAttach(Array.from(e.target.files));
    e.target.value = '';
  };

  return (
    <div className="composer">
      <div className="composer-inner">
        {/* biome-ignore lint/a11y/noStaticElementInteractions: drop zone for file attachments */}
        <div className="composer-card" onDragOver={handleDragOver} onDrop={handleDrop}>
          <input
            type="file"
            ref={fileInputRef}
            multiple
            onChange={handleFileChange}
            style={{ display: 'none' }}
          />
          {attachments && attachments.length > 0 && (
            <div className="composer-attachments">
              {attachments.map((a) => (
                <div key={a.localId} className={`composer-attachment-chip ${a.state}`}>
                  {a.type === 'image' && a.previewUrl ? (
                    <img src={a.previewUrl} alt={a.name} />
                  ) : (
                    <span className="composer-attachment-filename">{a.name}</span>
                  )}
                  {a.state === 'uploading' && <span className="composer-attachment-spinner" />}
                  {a.state === 'error' && <span className="composer-attachment-error">!</span>}
                  <button
                    type="button"
                    onClick={() => onRemoveAttachment?.(a.localId)}
                    aria-label="Remove"
                  >
                    &times;
                  </button>
                </div>
              ))}
            </div>
          )}
          <Input.TextArea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={placeholder ?? 'Send a message…'}
            autoSize={{ minRows: 1, maxRows: 8 }}
            style={{ caretColor: accent, fontSize: 14, lineHeight: 1.5 }}
            disabled={disabled}
          />
          <button
            type="button"
            className="composer-add-btn"
            onClick={() => fileInputRef.current?.click()}
            aria-label="Attach file"
          >
            +
          </button>
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
              disabled={disabled || (text.trim() === '' && !hasReadyAttachments) || isUploading}
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
