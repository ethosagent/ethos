import { type ReactNode, useId, useMemo } from 'react';

// Generative SVG mark — deterministic from personality id.
// 5x5 grid, mirror-symmetric, FNV-1a hash. Same algorithm as DESIGN.md spec.
// Circular frame echoing the ring logo (logo.svg annulus): background
// circle at accent 0x22 alpha, cells clipped to the circle, and an accent
// ring stroke around the circumference.
export function fnv1a(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export default function PersonalityMark({
  id,
  accent,
  size = 48,
}: {
  id: string;
  accent: string;
  size?: number;
}): ReactNode {
  const cells = 5;
  const cellSize = size / cells;
  const clipId = `mark-clip-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const ringWidth = Math.max(size * 0.04, 1);
  const rects = useMemo(() => {
    const seed = fnv1a(id);
    const out: Array<{ x: number; y: number; opacity: number }> = [];
    let bits = seed;
    for (let y = 0; y < cells; y++) {
      for (let x = 0; x < Math.ceil(cells / 2); x++) {
        const filled = bits & 1;
        bits = bits >>> 1;
        if (!bits) bits = fnv1a(id + y + x);
        if (filled) {
          const opacity = 0.55 + (bits & 0x3) / 8;
          out.push({ x: x * cellSize, y: y * cellSize, opacity });
          if (x !== cells - 1 - x) {
            out.push({ x: (cells - 1 - x) * cellSize, y: y * cellSize, opacity });
          }
        }
      }
    }
    return out;
  }, [id, cellSize]);

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <defs>
        <clipPath id={clipId}>
          <circle cx={size / 2} cy={size / 2} r={size / 2} />
        </clipPath>
      </defs>
      <circle cx={size / 2} cy={size / 2} r={size / 2} fill={`${accent}22`} />
      <g clipPath={`url(#${clipId})`}>
        {rects.map((r) => (
          <rect
            key={`${r.x}-${r.y}`}
            x={r.x}
            y={r.y}
            width={cellSize}
            height={cellSize}
            fill={accent}
            opacity={r.opacity}
          />
        ))}
      </g>
      <circle
        cx={size / 2}
        cy={size / 2}
        r={size / 2 - ringWidth / 2}
        fill="none"
        stroke={accent}
        strokeOpacity={0.55}
        strokeWidth={ringWidth}
      />
    </svg>
  );
}
