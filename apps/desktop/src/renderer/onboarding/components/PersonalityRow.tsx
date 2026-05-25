import { RadioOptionRow } from '../../ui/RadioOptionRow';
import { StatusDot } from '../../ui/StatusDot';

interface PersonalityRowProps {
  name: string;
  description: string;
  accent: string;
  selected: boolean;
  onSelect: () => void;
}

export function PersonalityRow({
  name,
  description,
  accent,
  selected,
  onSelect,
}: PersonalityRowProps) {
  return (
    <RadioOptionRow selected={selected} onClick={onSelect} accentColor={accent}>
      <div
        style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div
            style={{
              width: 28,
              height: 28,
              borderRadius: 'var(--radius-sm)',
              backgroundColor: `${accent}22`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <StatusDot color={accent} size={10} />
          </div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)' }}>
              {name}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{description}</div>
          </div>
        </div>
        <StatusDot color={accent} />
      </div>
    </RadioOptionRow>
  );
}
