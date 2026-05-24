import { useCallback, useRef } from 'react';

interface MemoryEditorProps {
  content: string;
  onChange: (content: string) => void;
  onSave: () => void;
}

export function MemoryEditor({ content, onChange, onSave }: MemoryEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const textarea = textareaRef.current;
        if (!textarea) return;
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const value = textarea.value;
        const updated = `${value.substring(0, start)}  ${value.substring(end)}`;
        onChange(updated);
        requestAnimationFrame(() => {
          textarea.selectionStart = start + 2;
          textarea.selectionEnd = start + 2;
        });
      }

      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        onSave();
      }
    },
    [onChange, onSave],
  );

  return (
    <textarea
      ref={textareaRef}
      value={content}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={handleKeyDown}
      spellCheck={false}
      style={{
        flex: 1,
        minHeight: 300,
        fontFamily: 'var(--font-mono)',
        fontSize: 13,
        lineHeight: 1.6,
        color: 'var(--text-primary)',
        background: 'var(--bg-base)',
        border: 'none',
        outline: 'none',
        padding: 0,
        resize: 'none',
        width: '100%',
      }}
    />
  );
}
