import { type KeyboardEvent, useCallback, useMemo, useState } from 'react';
import { PersonalityRingAvatar } from '../../ui/PersonalityRingAvatar';
import { CharacterSheetDrawer } from '../components/CharacterSheetDrawer';
import { TagPillInput } from '../components/TagPillInput';

interface EditorState {
  name: string;
  id: string;
  description: string;
  soulMd: string;
  tags: string[];
}

interface IdentityTabProps {
  personality: {
    id: string;
    name: string;
    description: string | null;
    capabilities: string[] | null;
    soulMd: string;
  };
  isNew: boolean;
  onChange: (changes: Partial<EditorState>) => void;
  port: number;
}

function toId(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]/g, '');
}

export function IdentityTab({ personality, isNew, onChange, port }: IdentityTabProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);

  const previewId = useMemo(() => {
    if (isNew) return toId(personality.name) || 'new';
    return personality.id;
  }, [isNew, personality.name, personality.id]);

  const handleNameChange = useCallback(
    (value: string) => {
      const changes: Partial<EditorState> = { name: value };
      if (isNew) {
        changes.id = toId(value);
      }
      onChange(changes);
    },
    [isNew, onChange],
  );

  const handleSoulMdKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const target = e.currentTarget;
      const start = target.selectionStart;
      const end = target.selectionEnd;
      const value = target.value;
      target.value = `${value.substring(0, start)}  ${value.substring(end)}`;
      target.selectionStart = start + 2;
      target.selectionEnd = start + 2;
      target.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, []);

  return (
    <div style={{ display: 'flex', gap: 32 }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 20 }}>
        <input
          type="text"
          value={personality.name}
          onChange={(e) => handleNameChange(e.target.value)}
          placeholder="Personality name"
          style={{
            fontSize: 24,
            fontWeight: 600,
            fontFamily: 'var(--font-display)',
            color: 'var(--text-primary)',
            backgroundColor: 'var(--bg-elevated)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 4,
            outline: 'none',
            padding: '4px 12px',
            width: '100%',
          }}
          onFocus={(e) => {
            e.target.style.border = '1px solid var(--accent)';
          }}
          onBlur={(e) => {
            e.target.style.border = '1px solid var(--border-subtle)';
          }}
        />

        <div
          style={{
            fontSize: 12,
            color: 'var(--text-tertiary)',
            fontFamily: 'var(--font-mono)',
            marginTop: -12,
          }}
        >
          id: {isNew ? toId(personality.name) || '...' : personality.id}
          {isNew && (
            <span style={{ marginLeft: 8, fontFamily: 'var(--font-display)', fontStyle: 'italic' }}>
              (auto-generated from name)
            </span>
          )}
        </div>

        <input
          type="text"
          value={personality.description ?? ''}
          onChange={(e) => onChange({ description: e.target.value })}
          placeholder="e.g. A focused agent for research and summarization"
          style={{
            fontSize: 14,
            height: 36,
            backgroundColor: 'var(--bg-elevated)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 4,
            padding: '0 12px',
            color: 'var(--text-primary)',
            outline: 'none',
            width: '100%',
          }}
        />

        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: -14 }}>
          e.g. "A focused research assistant for academic papers and summaries"
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <span
              style={{
                fontSize: 11,
                fontWeight: 500,
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                color: 'var(--text-tertiary)',
              }}
            >
              SOUL.md
            </span>
            <span
              style={{
                fontSize: 11,
                color: 'var(--text-tertiary)',
                fontFamily: 'var(--font-mono)',
              }}
            >
              {personality.soulMd.length}
            </span>
          </div>
          <textarea
            value={personality.soulMd}
            onChange={(e) => onChange({ soulMd: e.target.value })}
            onKeyDown={handleSoulMdKeyDown}
            placeholder={
              'I am [name]. I [core purpose]. I speak [style]...\n\nWrite in first person. Tab key inserts 2 spaces.'
            }
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 13,
              color: 'var(--text-primary)',
              backgroundColor: 'var(--bg-elevated)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 8,
              padding: 16,
              minHeight: 220,
              resize: 'vertical',
              outline: 'none',
              width: '100%',
              lineHeight: 1.5,
            }}
          />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span
            style={{
              fontSize: 11,
              fontWeight: 500,
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              color: 'var(--text-tertiary)',
            }}
          >
            Tags
          </span>
          <TagPillInput
            tags={personality.capabilities ?? []}
            onChange={(tags) => onChange({ tags })}
          />
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
            e.g. research, writing, analysis — press Enter or comma to add a tag
          </div>
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 12,
          paddingTop: 8,
          flexShrink: 0,
        }}
      >
        <PersonalityRingAvatar personalityId={previewId} name={personality.name} size={64} />
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            fontSize: 12,
            color: 'var(--accent)',
            textDecoration: 'underline',
            padding: 0,
          }}
        >
          Character sheet
        </button>

        <CharacterSheetDrawer
          personalityId={personality.id || previewId}
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          port={port}
        />
      </div>
    </div>
  );
}
