import type { ReactNode } from 'react';

// Personality mark — the circular annulus ring, the exact Ethos logo
// geometry (logo.svg): an outer ring cut by an inner ring via evenodd.
// Replaces the earlier 5×5 generative grid mark on the docs surface
// (see DESIGN.md decisions log, 2026-07-16).
const ANNULUS_PATH =
  'M50 5 A45 45 0 1 1 50 95 A45 45 0 1 1 50 5 Z M50 30 A20 20 0 1 0 50 70 A20 20 0 1 0 50 30 Z';

export default function PersonalityMark({
  id,
  accent,
  size = 48,
}: {
  id: string;
  accent: string;
  size?: number;
}): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      aria-hidden="true"
      data-mark={id}
      style={{ display: 'block' }}
    >
      <path fill={accent} fillRule="evenodd" d={ANNULUS_PATH} />
    </svg>
  );
}
