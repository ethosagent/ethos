import type { ReactNode } from 'react';

interface SectionLabelProps {
  children: ReactNode;
}

export function SectionLabel({ children }: SectionLabelProps) {
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 500,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color: 'var(--text-tertiary)',
      }}
    >
      {children}
    </span>
  );
}
