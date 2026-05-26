import { useCallback, useEffect, useState } from 'react';
import { SectionLabel } from '../ui/SectionLabel';
import { MemoryEditor } from './MemoryEditor';
import { MemoryView } from './MemoryView';
import { useMemory } from './useMemory';

interface MemoryPanelProps {
  label: string;
  store: 'memory' | 'user';
  personalityId: string;
  userId?: string;
  emptyText: string;
  onDirtyChange?: (store: string, isDirty: boolean) => void;
}

type Mode = 'view' | 'edit';

function useRelativeTime(iso: string | null): string {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(interval);
  }, []);

  if (!iso) return '';

  const diffMs = now - new Date(iso).getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

  if (diffDay > 0) return rtf.format(-diffDay, 'day');
  if (diffHr > 0) return rtf.format(-diffHr, 'hour');
  if (diffMin > 0) return rtf.format(-diffMin, 'minute');
  return rtf.format(-diffSec, 'second');
}

function wordCount(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
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
  const { content, modifiedAt, loading, error, reload, save } = useMemory(
    store,
    personalityId,
    userId,
  );
  const [mode, setMode] = useState<Mode>('view');
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset edit state when selection changes
  useEffect(() => {
    setMode('view');
    setDraft('');
    setDirty(false);
  }, [personalityId, userId]);

  const handleEdit = useCallback(() => {
    setDraft(content);
    setMode('edit');
    setDirty(false);
  }, [content]);

  const handleCancel = useCallback(() => {
    setDraft('');
    setMode('view');
    setDirty(false);
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    const ok = await save(draft);
    setSaving(false);
    if (ok) {
      setMode('view');
      setDirty(false);
    }
  }, [draft, save]);

  const handleDraftChange = useCallback((value: string) => {
    setDraft(value);
    setDirty(true);
  }, []);

  const isDirty = mode === 'edit' && dirty;

  useEffect(() => {
    onDirtyChange?.(store, isDirty);
  }, [store, isDirty, onDirtyChange]);

  const relativeTime = useRelativeTime(modifiedAt);
  const displayContent = mode === 'edit' ? draft : content;
  const words = wordCount(displayContent);

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 8,
        minWidth: 0,
      }}
    >
      {/* Header */}
      <div
        style={{
          height: 36,
          padding: '0 16px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottom: '1px solid var(--border-subtle)',
          flexShrink: 0,
        }}
      >
        <SectionLabel>{label}</SectionLabel>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {mode === 'view' ? (
            <button
              type="button"
              onClick={handleEdit}
              disabled={loading}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--info)',
                fontSize: 12,
                cursor: loading ? 'default' : 'pointer',
                padding: 0,
                fontFamily: 'var(--font-display)',
                opacity: loading ? 0.5 : 1,
              }}
            >
              Edit
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                style={{
                  background: 'none',
                  border: '1px solid var(--border-subtle)',
                  color: 'var(--text-primary)',
                  fontSize: 12,
                  fontFamily: 'var(--font-display)',
                  height: 24,
                  borderRadius: 4,
                  padding: '0 8px',
                  cursor: saving ? 'default' : 'pointer',
                  opacity: saving ? 0.5 : 1,
                }}
              >
                {saving ? 'Saving...' : 'Done'}
              </button>
              <button
                type="button"
                onClick={handleCancel}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--text-tertiary)',
                  fontSize: 12,
                  cursor: 'pointer',
                  padding: 0,
                  fontFamily: 'var(--font-display)',
                }}
              >
                Cancel
              </button>
            </>
          )}
        </div>
      </div>

      {/* Content */}
      <div
        style={{
          flex: 1,
          padding: 16,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {loading ? (
          <SkeletonLoader />
        ) : error ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
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
        ) : mode === 'edit' ? (
          <MemoryEditor content={draft} onChange={handleDraftChange} onSave={handleSave} />
        ) : content ? (
          <MemoryView content={content} />
        ) : (
          <div
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 14,
              color: 'var(--text-tertiary)',
              textAlign: 'center',
              padding: '0 24px',
            }}
          >
            {emptyText}
          </div>
        )}
      </div>

      {/* Footer */}
      <div
        style={{
          height: 28,
          padding: '0 16px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderTop: '1px solid var(--border-subtle)',
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--text-tertiary)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {modifiedAt ? `Updated ${relativeTime}` : 'Never updated'}
        </span>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--text-tertiary)',
          }}
        >
          {words} {words === 1 ? 'word' : 'words'}
        </span>
      </div>
    </div>
  );
}
