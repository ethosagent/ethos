import { personalityAccent } from '@ethosagent/design-tokens';

interface PersonalityRingAvatarProps {
  personalityId: string;
  name: string;
  size?: number; // 28 | 32 | 56, default 32
}

export function PersonalityRingAvatar({
  personalityId,
  name,
  size = 32,
}: PersonalityRingAvatarProps) {
  const color = personalityAccent(personalityId);
  const initials = name.slice(0, 2).toUpperCase();
  const fontSize = size < 32 ? 10 : size > 40 ? 18 : 12;
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        border: `2px solid ${color}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        fontFamily: 'var(--font-mono)',
        fontSize,
        fontWeight: 500,
        color,
        background: 'transparent',
      }}
    >
      {initials}
    </div>
  );
}
