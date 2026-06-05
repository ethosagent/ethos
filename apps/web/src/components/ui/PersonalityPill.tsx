interface PersonalityPillProps {
  name: string;
  color: string;
}

export function PersonalityPill({ name, color }: PersonalityPillProps) {
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 500,
        color,
        border: `1px solid ${color}`,
        borderRadius: 'var(--radius-full)',
        padding: '2px 8px',
        whiteSpace: 'nowrap',
        lineHeight: 1.4,
      }}
    >
      {name}
    </span>
  );
}
