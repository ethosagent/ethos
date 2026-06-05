import { useState } from 'react';
import { PersonalityRingAvatar } from '../ui/PersonalityRingAvatar';

interface PersonalityListItem {
  id: string;
  name: string;
  description: string | null;
  builtin: boolean;
}

interface PersonalityListRowProps {
  personality: PersonalityListItem;
  active: boolean;
  accentColor: string;
  onClick: () => void;
  onDuplicate?: () => void;
  onDelete?: () => void;
}

export function PersonalityListRow({
  personality,
  active,
  accentColor,
  onClick,
  onDuplicate,
  onDelete,
}: PersonalityListRowProps) {
  const [hovered, setHovered] = useState(false);

  return (
    // biome-ignore lint/a11y/useSemanticElements: custom styled personality row
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        minHeight: 48,
        padding: '4px 12px',
        cursor: 'pointer',
        borderLeft: active ? `2px solid ${accentColor}` : '2px solid transparent',
        borderBottom: '1px solid var(--border-subtle)',
        backgroundColor: active
          ? 'var(--bg-overlay)'
          : hovered
            ? 'var(--bg-overlay)'
            : 'transparent',
        transition: 'background-color var(--motion-fast) var(--ease)',
        gap: 10,
      }}
    >
      <PersonalityRingAvatar personalityId={personality.id} name={personality.name} size={32} />
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          gap: 1,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span
            style={{
              fontSize: 14,
              fontWeight: 500,
              color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {personality.name}
          </span>
          {personality.builtin && (hovered || active) && (
            <span
              style={{
                fontSize: 10,
                fontWeight: 400,
                color: 'var(--text-tertiary)',
                flexShrink: 0,
              }}
            >
              built-in
            </span>
          )}
        </div>
        {personality.description && (
          <span
            style={{
              fontSize: 12,
              color: 'var(--text-secondary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {personality.description}
          </span>
        )}
      </div>
      {hovered && (
        // biome-ignore lint/a11y/noStaticElementInteractions: stop propagation wrapper for action buttons
        <div
          style={{
            display: 'flex',
            gap: 4,
            flexShrink: 0,
          }}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          {onDuplicate && (
            <button
              type="button"
              onClick={onDuplicate}
              style={{
                background: 'none',
                border: '1px solid var(--border-strong)',
                borderRadius: 4,
                padding: '2px 8px',
                fontSize: 11,
                color: 'var(--text-secondary)',
                cursor: 'pointer',
              }}
            >
              Dup
            </button>
          )}
          {onDelete && !personality.builtin && (
            <button
              type="button"
              onClick={onDelete}
              style={{
                background: 'none',
                border: '1px solid var(--border-strong)',
                borderRadius: 4,
                padding: '2px 8px',
                fontSize: 11,
                color: 'var(--red, #f87171)',
                cursor: 'pointer',
              }}
            >
              Del
            </button>
          )}
        </div>
      )}
    </div>
  );
}
