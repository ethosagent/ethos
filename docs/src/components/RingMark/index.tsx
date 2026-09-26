import type { ReactNode } from 'react';

// Agent mark = the annulus: a colorful ring, nothing in the center (logo
// geometry — see DESIGN.md decisions 2026-07-16 and 2026-09-26).
export interface RingMarkProps {
  accent: string;
  size?: number;
  className?: string;
}

export default function RingMark({ accent, size = 44, className }: RingMarkProps): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 26 26" aria-hidden="true" className={className}>
      <circle cx="13" cy="13" r="10.2" fill="none" stroke={accent} strokeWidth="3.2" />
    </svg>
  );
}
