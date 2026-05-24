import { type KeyboardEvent, useCallback, useState } from 'react';

interface TagPillInputProps {
  tags: string[];
  onChange: (tags: string[]) => void;
}

export function TagPillInput({ tags, onChange }: TagPillInputProps) {
  const [input, setInput] = useState('');

  const addTag = useCallback(
    (raw: string) => {
      const value = raw.trim();
      if (value && !tags.includes(value)) {
        onChange([...tags, value]);
      }
      setInput('');
    },
    [tags, onChange],
  );

  const removeTag = useCallback(
    (index: number) => {
      onChange(tags.filter((_, i) => i !== index));
    },
    [tags, onChange],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        addTag(input);
      }
      if (e.key === 'Backspace' && input === '' && tags.length > 0) {
        removeTag(tags.length - 1);
      }
    },
    [input, tags, addTag, removeTag],
  );

  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 4,
        minHeight: 36,
        padding: '4px 8px',
        backgroundColor: 'var(--bg-elevated)',
        borderRadius: 4,
        border: '1px solid var(--border-subtle)',
      }}
    >
      {tags.map((tag, i) => (
        <span
          key={tag}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: '4px 8px',
            backgroundColor: 'var(--bg-overlay)',
            borderRadius: 4,
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            color: 'var(--text-primary)',
          }}
        >
          {tag}
          <button
            type="button"
            onClick={() => removeTag(i)}
            style={{
              background: 'none',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              color: 'var(--text-tertiary)',
              fontSize: 14,
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </span>
      ))}
      <input
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          if (input.trim()) addTag(input);
        }}
        placeholder={tags.length === 0 ? 'Add tags...' : ''}
        style={{
          flex: 1,
          minWidth: 60,
          border: 'none',
          outline: 'none',
          background: 'transparent',
          fontFamily: 'var(--font-mono)',
          fontSize: 12,
          color: 'var(--text-primary)',
          padding: '4px 0',
        }}
      />
    </div>
  );
}
