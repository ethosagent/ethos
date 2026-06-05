import { useCallback, useEffect, useState } from 'react';
import { PersonalityRingAvatar } from '../ui/PersonalityRingAvatar';

export interface PickerPersonality {
  id: string;
  name: string;
  description?: string;
  model?: string;
}

interface PersonalityPickerModalProps {
  personalities: PickerPersonality[];
  onSelect: (personalityId: string) => void;
  onClose: () => void;
}

export function PersonalityPickerModal({
  personalities,
  onSelect,
  onClose,
}: PersonalityPickerModalProps) {
  const [selectedId, setSelectedId] = useState<string | null>(personalities[0]?.id ?? null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    },
    [onClose],
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  const handleStart = useCallback(() => {
    if (selectedId) onSelect(selectedId);
  }, [selectedId, onSelect]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: modal overlay click-to-dismiss
    <div
      role="presentation"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0, 0, 0, 0.6)',
      }}
      onClick={handleOverlayClick}
    >
      <div
        style={{
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-strong)',
          borderRadius: 16,
          maxWidth: 480,
          width: '90%',
          maxHeight: '80vh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Title */}
        <div
          style={{
            padding: '20px 24px 12px',
            fontFamily: 'var(--font-display)',
            fontSize: 16,
            fontWeight: 600,
            color: 'var(--text-primary)',
          }}
        >
          Start a new session
        </div>

        {/* Personality list */}
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '0 12px',
            minHeight: 0,
          }}
        >
          {personalities.map((p) => {
            const isSelected = p.id === selectedId;
            const isHovered = p.id === hoveredId;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => setSelectedId(p.id)}
                onDoubleClick={() => onSelect(p.id)}
                onMouseEnter={() => setHoveredId(p.id)}
                onMouseLeave={() => setHoveredId(null)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  width: '100%',
                  padding: '10px 12px',
                  borderRadius: 'var(--radius-md)',
                  background: isSelected
                    ? 'rgba(74, 158, 255, 0.12)'
                    : isHovered
                      ? 'var(--ethos-hover)'
                      : 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  textAlign: 'left',
                  font: 'inherit',
                  transition: `background-color var(--motion-fast) var(--ease)`,
                }}
              >
                <PersonalityRingAvatar personalityId={p.id} name={p.name} size={36} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontFamily: 'var(--font-display)',
                      fontSize: 14,
                      fontWeight: 500,
                      color: 'var(--text-primary)',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {p.name}
                  </div>
                  {p.description && (
                    <div
                      style={{
                        fontFamily: 'var(--font-display)',
                        fontSize: 12,
                        color: 'var(--text-tertiary)',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        marginTop: 1,
                      }}
                    >
                      {p.description}
                    </div>
                  )}
                </div>
                {p.model && (
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 10,
                      fontWeight: 500,
                      color: 'var(--text-tertiary)',
                      background: 'var(--bg-overlay)',
                      padding: '2px 6px',
                      borderRadius: 'var(--radius-sm)',
                      flexShrink: 0,
                    }}
                  >
                    {p.model}
                  </span>
                )}
                {isSelected && (
                  <span
                    style={{
                      fontSize: 14,
                      color: 'var(--info)',
                      flexShrink: 0,
                    }}
                  >
                    ✓
                  </span>
                )}
              </button>
            );
          })}
          {personalities.length === 0 && (
            <div
              style={{
                padding: '24px 12px',
                textAlign: 'center',
                fontFamily: 'var(--font-display)',
                fontSize: 13,
                color: 'var(--text-tertiary)',
              }}
            >
              No personalities available
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 8,
            padding: '12px 24px 20px',
            borderTop: '1px solid var(--border-subtle)',
          }}
        >
          <button
            type="button"
            onClick={onClose}
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 12,
              fontWeight: 500,
              color: 'var(--text-secondary)',
              background: 'transparent',
              border: '1px solid var(--border-strong)',
              borderRadius: 'var(--radius-sm)',
              padding: '6px 12px',
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleStart}
            disabled={!selectedId}
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 12,
              fontWeight: 500,
              color: '#fff',
              background: selectedId ? 'var(--blue)' : 'var(--blue)',
              opacity: selectedId ? 1 : 0.4,
              border: 'none',
              borderRadius: 'var(--radius-sm)',
              padding: '6px 12px',
              cursor: selectedId ? 'pointer' : 'not-allowed',
            }}
          >
            Start session →
          </button>
        </div>
      </div>
    </div>
  );
}
