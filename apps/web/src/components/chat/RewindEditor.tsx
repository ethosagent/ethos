import { REWIND_NOTICE } from '@ethosagent/surface-kit';
import { useEffect, useRef, useState } from 'react';

// Inline editor that replaces a user bubble while "Edit & rerun" is open.
// The rerun itself (fork + resend) is the caller's; this only owns the text,
// the pending state and the refusal message. A rejection keeps the text.
export function RewindEditor({
  initialText,
  hadAttachments,
  onRerun,
  onCancel,
}: {
  initialText: string;
  hadAttachments: boolean;
  onRerun: (text: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initialText);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const canRerun = text.trim().length > 0 && !pending;

  const rerun = async () => {
    if (!canRerun) return;
    setPending(true);
    setError(null);
    try {
      await onRerun(text);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPending(false);
    }
  };

  return (
    <div className="rewind-editor">
      <textarea
        ref={ref}
        className="rewind-editor-input"
        aria-label="Edit prompt"
        value={text}
        rows={Math.min(10, Math.max(2, text.split('\n').length))}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void rerun();
          }
        }}
      />
      <div className="rewind-editor-notice">
        {REWIND_NOTICE}
        {hadAttachments ? ' Attached files are not re-sent.' : ''}
      </div>
      {error ? (
        <div className="rewind-editor-error" role="alert">
          {error}
        </div>
      ) : null}
      <div className="rewind-editor-actions">
        <button type="button" className="rewind-editor-btn" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="rewind-editor-btn rewind-editor-btn-primary"
          disabled={!canRerun}
          onClick={() => void rerun()}
        >
          {pending ? 'Rerunning…' : 'Rerun'}
        </button>
      </div>
    </div>
  );
}
