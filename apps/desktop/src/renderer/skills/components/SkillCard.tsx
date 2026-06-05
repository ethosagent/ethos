import { useState } from 'react';
import { Chip } from '../../ui/Chip';

interface SkillCardProps {
  skill: {
    id: string;
    name: string;
    description: string | null;
    modifiedAt: string;
    source: string;
  };
  installed?: boolean;
  onImport: () => void;
  onRemove?: () => void;
  onClick: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(diff / 3_600_000);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(diff / 86_400_000);
  return `${days}d ago`;
}

export function SkillCard({
  skill,
  installed,
  onImport,
  onRemove,
  onClick,
  onEdit,
  onDelete,
}: SkillCardProps) {
  const [hovered, setHovered] = useState(false);

  return (
    // biome-ignore lint/a11y/useSemanticElements: container holds nested buttons; cannot use <button>
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onClick();
      }}
      role="button"
      tabIndex={0}
      style={{
        position: 'relative',
        backgroundColor: 'var(--bg-elevated)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-md)',
        padding: '14px 16px',
        marginBottom: 12,
        cursor: 'pointer',
        transition: `border-color var(--motion-fast) var(--ease)`,
        borderColor: hovered ? 'var(--text-tertiary)' : 'var(--border-subtle)',
      }}
    >
      {/* Hover actions: edit + delete */}
      <div
        style={{
          position: 'absolute',
          top: 12,
          right: 12,
          display: 'flex',
          gap: 8,
          opacity: hovered ? 1 : 0,
          transition: `opacity var(--motion-fast) var(--ease)`,
          pointerEvents: hovered ? 'auto' : 'none',
        }}
      >
        <button
          type="button"
          title="Edit"
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            fontSize: 14,
            color: 'var(--text-secondary)',
            padding: 0,
            lineHeight: 1,
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.color = 'var(--text-primary)';
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.color = 'var(--text-secondary)';
          }}
        >
          &#9998;
        </button>
        <button
          type="button"
          title="Delete"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            fontSize: 14,
            color: 'var(--text-secondary)',
            padding: 0,
            lineHeight: 1,
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.color = 'var(--text-primary)';
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.color = 'var(--text-secondary)';
          }}
        >
          &#128465;
        </button>
      </div>

      {/* Row 1: icon circle + name + import/installed */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div
          style={{
            width: 28,
            height: 28,
            borderRadius: '50%',
            background: 'rgba(74, 158, 255, 0.12)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--blue)',
            fontWeight: 600,
          }}
        >
          {skill.name.charAt(0).toUpperCase()}
        </div>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 13,
            fontWeight: 500,
            color: 'var(--text-primary)',
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {skill.name}
        </span>
        {installed !== undefined ? (
          installed ? (
            hovered && onRemove ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove();
                }}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: 12,
                  color: 'var(--error)',
                  padding: 0,
                  whiteSpace: 'nowrap',
                }}
              >
                Remove
              </button>
            ) : (
              <Chip label="Installed" variant="success" />
            )
          ) : (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onImport();
              }}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                fontSize: 12,
                color: 'var(--info)',
                padding: 0,
                whiteSpace: 'nowrap',
              }}
            >
              Import
            </button>
          )
        ) : (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onImport();
            }}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontSize: 12,
              color: 'var(--info)',
              padding: 0,
              whiteSpace: 'nowrap',
            }}
          >
            Import
          </button>
        )}
      </div>

      {/* Row 2: description */}
      <div
        style={{
          fontSize: 12,
          color: 'var(--text-secondary)',
          lineHeight: 1.4,
          marginTop: 6,
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}
      >
        {skill.description || 'No description'}
      </div>

      {/* Row 3: metadata */}
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          color: 'var(--text-tertiary)',
          marginTop: 8,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {skill.source} · Modified {relativeTime(skill.modifiedAt)}
      </div>
    </div>
  );
}
