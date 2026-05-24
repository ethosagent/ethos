import { personalityAccent } from '@ethosagent/design-tokens';
import { generatePersonalityMark } from '@ethosagent/web-contracts';

interface MarkPreviewProps {
  personalityId: string;
  size?: number;
  showLabel?: boolean;
}

export function MarkPreview({ personalityId, size = 64, showLabel }: MarkPreviewProps) {
  const labelVisible = showLabel ?? size >= 48;
  const spec = generatePersonalityMark(personalityId);
  const accent = personalityAccent(personalityId);
  const cellSize = size / 5;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={`${personalityId} mark`}
        style={{ display: 'block', flexShrink: 0 }}
      >
        <rect
          x={0}
          y={0}
          width={size}
          height={size}
          rx={size * spec.bgRadius}
          fill={accent}
          fillOpacity={spec.bgAlpha}
        />
        {spec.cells.map(({ row, col, opacity }) => (
          <rect
            key={`${row}-${col}`}
            x={col * cellSize}
            y={row * cellSize}
            width={cellSize}
            height={cellSize}
            fill={accent}
            fillOpacity={opacity}
          />
        ))}
      </svg>
      {labelVisible && (
        <span
          style={{
            fontSize: 11,
            fontWeight: 500,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            color: 'var(--text-tertiary)',
          }}
        >
          Mark
        </span>
      )}
    </div>
  );
}
