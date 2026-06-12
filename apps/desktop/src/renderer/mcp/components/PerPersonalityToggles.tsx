import { createEthosClient } from '@ethosagent/sdk';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useServerUrl } from '../../shell/ServerUrl';
import { Toggle } from '../../ui/Toggle';

interface PersonalityEntry {
  id: string;
  name: string;
  attached: boolean;
}

interface PerPersonalityTogglesProps {
  serverName: string;
}

export function PerPersonalityToggles({ serverName }: PerPersonalityTogglesProps) {
  const baseUrl = useServerUrl();
  const client = useMemo(() => createEthosClient({ baseUrl, fetch: globalThis.fetch }), [baseUrl]);

  const [entries, setEntries] = useState<PersonalityEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await client.rpc.personalities.list({});
        const personalities = res.items as Array<{
          id: string;
          name: string;
          mcpServers?: string[];
        }>;
        if (cancelled) return;
        setEntries(
          personalities.map((p) => ({
            id: p.id,
            name: p.name,
            attached: p.mcpServers?.includes(serverName) ?? false,
          })),
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, serverName]);

  const handleToggle = useCallback(
    async (personalityId: string, checked: boolean) => {
      setEntries((prev) =>
        prev.map((e) => (e.id === personalityId ? { ...e, attached: checked } : e)),
      );

      const updated = entries
        .map((e) => (e.id === personalityId ? { ...e, attached: checked } : e))
        .filter((e) => e.attached)
        .map((e) => e.id);

      await client.rpc.mcp.attachPersonalities({ serverName, personalityIds: updated });
    },
    [client, serverName, entries],
  );

  if (loading) {
    return (
      <div style={{ fontSize: 13, color: 'var(--text-secondary)', padding: '8px 0' }}>
        Loading personalities...
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div style={{ fontSize: 13, color: 'var(--text-secondary)', padding: '8px 0' }}>
        No personalities found.
      </div>
    );
  }

  return (
    <div>
      {entries.map((entry) => (
        <div
          key={entry.id}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            height: 36,
            borderBottom: '1px solid var(--border-subtle)',
          }}
        >
          <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>{entry.name}</span>
          <Toggle
            checked={entry.attached}
            onChange={(checked) => {
              void handleToggle(entry.id, checked);
            }}
          />
        </div>
      ))}
    </div>
  );
}
