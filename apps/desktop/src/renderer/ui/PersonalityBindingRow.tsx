import { createEthosClient } from '@ethosagent/sdk';
import { useEffect, useMemo, useState } from 'react';
import { useAppState } from '../state/AppContext';

interface PersonalityItem {
  id: string;
  name: string;
}

interface PersonalityBindingRowProps {
  value: string | null;
  onChange: (personalityId: string) => void;
  label?: string;
}

export function PersonalityBindingRow({
  value,
  onChange,
  label = 'Which agent should respond?',
}: PersonalityBindingRowProps) {
  const { state } = useAppState();
  const baseUrl = `http://localhost:${state.port}`;
  const client = useMemo(() => createEthosClient({ baseUrl, fetch: globalThis.fetch }), [baseUrl]);

  const [items, setItems] = useState<PersonalityItem[]>([]);

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
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <label
        htmlFor="personality-binding"
        style={{
          fontSize: 13,
          color: 'var(--text-secondary)',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </label>
      <select
        id="personality-binding"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        style={{
          flex: 1,
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
        {items.length === 0 ? (
          <option value="" disabled>
            Loading...
          </option>
        ) : (
          <option value="" disabled>
            Select personality
          </option>
        )}
        {items.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </div>
  );
}
