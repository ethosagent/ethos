import { personalityAccent } from '@ethosagent/design-tokens';

interface PersonalityRingAvatarProps {
  personalityId: string;
  name?: string;
  size?: number;
}

export function PersonalityRingAvatar({
  personalityId,
  size = 32,
}: PersonalityRingAvatarProps) {
  const color = personalityAccent(personalityId);
  const borderWidth = 3;
  const svgSize = Math.round(size * 0.44);
  const outerR = 5;
  const innerR = 2;
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        border: `${borderWidth}px solid ${color}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        background: 'var(--bg-base)',
      }}
    >
      <svg
        width={svgSize}
        height={svgSize}
        viewBox="0 0 16 16"
        aria-hidden="true"
      >
        <circle
          cx="8"
          cy="8"
          r={outerR}
          fill="none"
          stroke={color}
          strokeWidth="2.5"
        />
        <circle cx="8" cy="8" r={innerR} fill={color} />
      </svg>
    </div>
  );
}
