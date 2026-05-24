import { useState } from 'react';
import { MarkPreview } from './components/MarkPreview';

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
}

export function PersonalityListRow({
  personality,
  active,
  accentColor,
  onClick,
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
        height: 44,
        padding: '0 12px',
        cursor: 'pointer',
        borderLeft: active ? `2px solid ${accentColor}` : '2px solid transparent',
        backgroundColor: active
          ? 'var(--bg-overlay)'
          : hovered
            ? 'var(--bg-overlay)'
            : 'transparent',
        transition: 'background-color var(--motion-fast) var(--ease)',
        gap: 10,
      }}
    >
      <MarkPreview personalityId={personality.id} size={28} />
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
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          backgroundColor: accentColor,
          flexShrink: 0,
        }}
      />
    </div>
  );
}
