import { createEthosClient } from '@ethosagent/sdk';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useServerUrl } from '../../shell/ServerUrl';
import { CreateKeyDrawer } from './CreateKeyDrawer';
import { KeyRevealPanel } from './KeyRevealPanel';
import type { ApiKey } from './KeyTable';
import { KeyTable } from './KeyTable';

export function ApiKeysPage() {
  const baseUrl = useServerUrl();
  const client = useMemo(() => createEthosClient({ baseUrl, fetch: globalThis.fetch }), [baseUrl]);

  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [revealedKey, setRevealedKey] = useState<string | null>(null);

  const loadKeys = useCallback(async () => {
    try {
      const res = await client.rpc.apiKeys.list({});
      setKeys(res.items as ApiKey[]);
    } catch {
      // best-effort
    }
  }, [client]);

  useEffect(() => {
    loadKeys();
  }, [loadKeys]);

  const handleRevoke = useCallback(
    async (id: string) => {
      try {
        await client.rpc.apiKeys.revoke({ id });
        await loadKeys();
      } catch {
        // best-effort
      }
    },
    [client, loadKeys],
  );

  const handleCreate = useCallback(
    async (params: { name: string; scopes: string[]; allowedOrigins: string[] }) => {
      try {
        const res = await client.rpc.apiKeys.create({
          name: params.name,
          scopes: params.scopes as (
            | 'sessions:read'
            | 'sessions:write'
            | 'chat:send'
            | 'personalities:read'
            | 'memory:read'
            | 'memory:write'
            | 'tools:approve'
            | 'events:subscribe'
          )[],
          allowedOrigins: params.allowedOrigins,
        });
        setRevealedKey(res.secret as string);
        await loadKeys();
      } catch {
        // best-effort
      }
    },
    [client, loadKeys],
  );

  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          height: 40,
        }}
      >
        <h3
          style={{
            margin: 0,
            fontSize: 16,
            fontWeight: 600,
            color: 'var(--text-primary)',
          }}
        >
          API Keys
        </h3>
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          style={{
            height: 28,
            padding: '0 12px',
            borderRadius: 4,
            border: '1px solid var(--border-subtle)',
            background: 'transparent',
            color: 'var(--text-primary)',
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          Create key
        </button>
      </div>

      {revealedKey && (
        <KeyRevealPanel keyValue={revealedKey} onDismiss={() => setRevealedKey(null)} />
      )}

      <KeyTable keys={keys} onRevoke={handleRevoke} />

      <CreateKeyDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onCreate={handleCreate}
      />
    </div>
  );
}
