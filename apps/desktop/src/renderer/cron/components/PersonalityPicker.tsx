import { createEthosClient } from '@ethosagent/sdk';
import { useEffect, useMemo, useState } from 'react';
import { useServerUrl } from '../../shell/ServerUrl';

interface PersonalityPickerProps {
  value: string | null;
  onChange: (personalityId: string) => void;
  id?: string;
}

interface PersonalityItem {
  id: string;
  name: string;
}

export function PersonalityPicker({ value, onChange, id }: PersonalityPickerProps) {
  const [items, setItems] = useState<PersonalityItem[]>([]);

  const baseUrl = useServerUrl();
  const client = useMemo(() => createEthosClient({ baseUrl, fetch: globalThis.fetch }), [baseUrl]);

  useEffect(() => {
    let cancelled = false;
    client.rpc.personalities
      .list({})
      .then((res) => {
        if (cancelled) return;
        setItems(
          res.items.map((p: { id: string; name: string }) => ({
            id: p.id,
            name: p.name,
          })),
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [client]);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <label
        htmlFor={id ?? 'personality-picker'}
        style={{
          fontSize: 13,
          color: 'var(--text-secondary)',
          whiteSpace: 'nowrap',
        }}
      >
        Run as
      </label>
      <select
        id={id ?? 'personality-picker'}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: 200,
          height: 32,
          fontFamily: 'var(--font-display)',
          fontSize: 13,
          color: 'var(--text-primary)',
          backgroundColor: 'var(--bg-elevated)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 4,
          padding: '0 8px',
          outline: 'none',
          appearance: 'auto',
        }}
      >
        <option value="" disabled>
          Select personality
        </option>
        {items.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </div>
  );
}
