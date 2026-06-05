import type { ReactNode } from 'react';

interface RadioOptionRowProps {
  selected: boolean;
  onClick: () => void;
  accentColor?: string;
  children: ReactNode;
}

export function RadioOptionRow({ selected, onClick, accentColor, children }: RadioOptionRowProps) {
  const borderColor = selected ? accentColor || 'var(--info)' : 'var(--border-subtle)';

  return (
    // biome-ignore lint/a11y/useSemanticElements: custom styled radio row
    <div
      role="radio"
      aria-checked={selected}
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        minHeight: 52,
        padding: '12px 16px',
        border: `1px solid ${borderColor}`,
        borderRadius: 'var(--radius-sm)',
        cursor: 'pointer',
        transition: `border-color var(--motion-fast) var(--ease), background-color var(--motion-fast) var(--ease)`,
        backgroundColor: selected
          ? accentColor
            ? `color-mix(in srgb, ${accentColor} 6%, transparent)`
            : 'rgba(74,158,255,0.06)'
          : 'transparent',
      }}
    >
      {children}
    </div>
  );
}
