import { personalityAccent } from '@ethosagent/design-tokens';
import { generatePersonalityMark } from '@ethosagent/web-contracts';
import { useId } from 'react';
import Svg, { Circle, ClipPath, Defs, G, Rect } from 'react-native-svg';

/** The personality mark (D14) — the same algorithm as the web's PersonalityMark. */
export function Mark({ personalityId, size = 30 }: { personalityId: string; size?: number }) {
  const spec = generatePersonalityMark(personalityId);
  const accent = personalityAccent(personalityId);
  const clipId = `mark-${useId()}`;
  const c = size / 2;
  const stroke = Math.max(1, size * 0.04);
  const cell = size / 5;
  return (
    <Svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      accessibilityRole="image"
      accessibilityLabel={`${personalityId} personality`}
    >
      <Defs>
        <ClipPath id={clipId}>
          <Circle cx={c} cy={c} r={c} />
        </ClipPath>
      </Defs>
      <Circle cx={c} cy={c} r={c} fill={accent} fillOpacity={spec.bgAlpha} />
      <Circle
        cx={c}
        cy={c}
        r={c - stroke / 2}
        fill="none"
        stroke={accent}
        strokeWidth={stroke}
        strokeOpacity={spec.ringAlpha}
      />
      <G clipPath={`url(#${clipId})`}>
        {spec.cells.map(({ row, col, opacity }) => (
          <Rect
            key={`${row}-${col}`}
            x={col * cell}
            y={row * cell}
            width={cell}
            height={cell}
            fill={accent}
            fillOpacity={opacity}
          />
        ))}
      </G>
    </Svg>
  );
}
