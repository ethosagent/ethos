import { useCallback, useMemo, useState } from 'react';
import { Toggle } from '../../ui/Toggle';
import { ModelTierRow } from '../components/ModelTierRow';

interface ModelTierConfig {
  trivial?: string;
  default?: string;
  deep?: string;
}

interface ModelTabProps {
  personality: {
    model: string | ModelTierConfig | null;
  };
  onChange: (model: string | ModelTierConfig | null) => void;
}

const MODEL_OPTIONS = ['claude-haiku-3-5', 'claude-sonnet-4', 'claude-opus-4'];

const TIERS: Array<{ key: keyof ModelTierConfig; label: string; description: string }> = [
  { key: 'trivial', label: 'Trivial', description: 'Quick lookups, simple formatting' },
  { key: 'default', label: 'Default', description: 'General conversation and tasks' },
  { key: 'deep', label: 'Deep', description: 'Complex reasoning, code generation' },
];

function toTierConfig(model: string | ModelTierConfig | null): ModelTierConfig {
  if (model === null || typeof model === 'string') {
    return { trivial: '', default: typeof model === 'string' ? model : '', deep: '' };
  }
  return model;
}

export function ModelTab({ personality, onChange }: ModelTabProps) {
  const [useDefaults, setUseDefaults] = useState(personality.model === null);

  const tierConfig = useMemo(() => toTierConfig(personality.model), [personality.model]);

  const handleDefaultsToggle = useCallback(
    (checked: boolean) => {
      setUseDefaults(checked);
      if (checked) {
        onChange(null);
      } else {
        onChange({ ...tierConfig });
      }
    },
    [onChange, tierConfig],
  );

  const handleTierChange = useCallback(
    (key: keyof ModelTierConfig, value: string) => {
      const updated = { ...tierConfig, [key]: value || undefined };
      const hasAny = updated.trivial ?? updated.default ?? updated.deep;
      if (!hasAny) {
        onChange(null);
      } else {
        onChange(updated);
      }
    },
    [tierConfig, onChange],
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 0',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)' }}>
            Use workspace defaults
          </span>
          <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
            Inherit model settings from workspace configuration
          </span>
        </div>
        <Toggle checked={useDefaults} onChange={handleDefaultsToggle} />
      </div>

      <div
        style={{
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-md)',
          overflow: 'hidden',
        }}
      >
        {TIERS.map(({ key, label, description }) => (
          <ModelTierRow
            key={key}
            tier={label}
            description={description}
            value={tierConfig[key] ?? ''}
            options={MODEL_OPTIONS}
            onChange={(value) => handleTierChange(key, value)}
            disabled={useDefaults}
          />
        ))}
      </div>
    </div>
  );
}
