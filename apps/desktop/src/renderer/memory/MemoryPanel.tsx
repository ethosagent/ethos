import { useCallback, useEffect, useRef, useState } from 'react';
import { useMemory } from './useMemory';

interface MemoryPanelProps {
  label: string;
  store: 'memory' | 'user';
  personalityId: string;
  userId?: string;
  emptyText: string;
  onDirtyChange?: (store: string, isDirty: boolean) => void;
}

function countMatches(text: string, q: string): number {
  if (!q) return 0;
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  let count = 0;
  let idx = lower.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = lower.indexOf(needle, idx + needle.length);
  }
  return count;
}

const skeletonKeyframes = `
@keyframes memoryPulse {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 0.8; }
}
`;

function SkeletonLoader() {
  const widths = ['80%', '60%', '90%', '45%'];
  return (
    <>
      <style>{skeletonKeyframes}</style>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {widths.map((w) => (
          <div
            key={w}
            style={{
              width: w,
              height: 8,
              borderRadius: 4,
              background: 'var(--bg-overlay)',
              animation: 'memoryPulse 1.5s ease-in-out infinite',
            }}
          />
        ))}
      </div>
    </>
  );
}

export function MemoryPanel({
  label,
  store,
  personalityId,
  userId,
  emptyText,
  onDirtyChange,
}: MemoryPanelProps) {
  const { content, loading, error, reload, save } = useMemory(store, personalityId, userId);
  const [draft, setDraft] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Sync from loaded content
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when data changes
  useEffect(() => {
    setDraft(content);
    setSavedContent(content);
    setSearch('');
  }, [content, personalityId, userId]);

  const dirty = draft !== savedContent;

  useEffect(() => {
    onDirtyChange?.(store, dirty);
  }, [store, dirty, onDirtyChange]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    const ok = await save(draft);
    setSaving(false);
    if (ok) {
      setSavedContent(draft);
    }
  }, [draft, save]);

  const handleRevert = useCallback(() => {
    if (!dirty) return;
    setDraft(savedContent);
  }, [dirty, savedContent]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(draft);
    } catch {
      // clipboard may not be available
    }
  }, [draft]);

  const handleClear = useCallback(async () => {
    const confirmed = window.confirm('This will clear all memory. Are you sure?');
    if (!confirmed) return;
    setDraft('');
    setSaving(true);
    const ok = await save('');
    setSaving(false);
    if (ok) {
      setSavedContent('');
    }
  }, [save]);

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
        setDraft(updated);
        requestAnimationFrame(() => {
          textarea.selectionStart = start + 2;
          textarea.selectionEnd = start + 2;
        });
      }

      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
    },
    [handleSave],
  );

  const matchCount = search ? countMatches(draft, search) : 0;

  if (loading) {
    return (
      <div style={{ flex: 1, padding: 16 }}>
        <SkeletonLoader />
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 16 }}>
        <span style={{ fontSize: 13, color: 'var(--error)' }}>{error}</span>
        <button
          type="button"
          onClick={reload}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--info)',
            fontSize: 13,
            cursor: 'pointer',
            padding: 0,
            fontFamily: 'var(--font-display)',
            textAlign: 'left',
          }}
        >
          Retry
        </button>
      </div>
    );
  }

  const actionBtnStyle: React.CSSProperties = {
    background: 'none',
    border: 'none',
    color: 'var(--text-secondary)',
    fontSize: 11,
    cursor: 'pointer',
    padding: '4px 8px',
    fontFamily: 'var(--font-display)',
    borderRadius: 4,
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      {/* Editor toolbar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 12,
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 13,
            fontWeight: 500,
            color: 'var(--text-primary)',
            flex: 1,
          }}
        >
          {label}
          {dirty ? <span style={{ color: 'var(--blue)', marginLeft: 4 }}>*</span> : null}
        </span>

        {/* Search */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            type="text"
            placeholder="Search..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{
              width: 160,
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 4,
              padding: '4px 8px',
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              color: 'var(--text-primary)',
              outline: 'none',
            }}
          />
          {search ? (
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                color: 'var(--text-tertiary)',
                whiteSpace: 'nowrap',
              }}
            >
              {matchCount} match{matchCount === 1 ? '' : 'es'}
            </span>
          ) : null}
        </div>

        {/* Action buttons */}
        <button type="button" onClick={handleCopy} style={actionBtnStyle}>
          Copy
        </button>
        <button
          type="button"
          onClick={handleRevert}
          disabled={!dirty}
          style={{ ...actionBtnStyle, opacity: dirty ? 1 : 0.4 }}
        >
          Revert
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={!dirty || saving}
          style={{
            ...actionBtnStyle,
            color: dirty ? 'var(--blue)' : 'var(--text-secondary)',
            opacity: dirty && !saving ? 1 : 0.4,
          }}
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
        <button
          type="button"
          onClick={handleClear}
          style={{ ...actionBtnStyle, color: 'var(--text-tertiary)' }}
        >
          Clear
        </button>
      </div>

      {/* Textarea editor */}
      <textarea
        ref={textareaRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        spellCheck={false}
        placeholder={emptyText}
        style={{
          flex: 1,
          width: '100%',
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 6,
          padding: 16,
          fontFamily: 'var(--font-mono)',
          fontSize: 12,
          lineHeight: 1.7,
          color: 'var(--text-primary)',
          resize: 'none',
          outline: 'none',
        }}
      />
    </div>
  );
}
