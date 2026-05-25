import { Chip } from '../../ui/Chip';
import { RadioOptionRow } from '../../ui/RadioOptionRow';

interface ProviderRowProps {
  name: string;
  description: string;
  selected: boolean;
  onSelect: () => void;
  badge?: { label: string; variant: 'success' | 'info' };
}

export function ProviderRow({ name, description, selected, onSelect, badge }: ProviderRowProps) {
  return (
    <RadioOptionRow selected={selected} onClick={onSelect}>
      <div
        style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
      >
        <div>
          <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)' }}>{name}</div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{description}</div>
        </div>
        {badge && <Chip label={badge.label} variant={badge.variant} />}
      </div>
    </RadioOptionRow>
  );
}
