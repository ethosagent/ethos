import { createEthosClient } from '@ethosagent/sdk';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useServerUrl } from '../../shell/ServerUrl';

interface McpServerAttachPickerProps {
  attachedServers: string[];
  onAttach: (servers: string[]) => void;
  onClose: () => void;
}

interface ServerEntry {
  name: string;
}

export function McpServerAttachPicker({
  attachedServers,
  onAttach,
  onClose,
}: McpServerAttachPickerProps) {
  const baseUrl = useServerUrl();
  const client = useMemo(() => createEthosClient({ baseUrl, fetch: globalThis.fetch }), [baseUrl]);

  const [allServers, setAllServers] = useState<ServerEntry[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set(attachedServers));
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await client.rpc.mcp.list({});
        if (!cancelled) {
          setAllServers(res.servers.map((s: { name: string }) => ({ name: s.name })));
        }
      } catch {
        // best-effort
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [client]);

  const toggleServer = useCallback((name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  }, []);

  const handleConfirm = useCallback(() => {
    onAttach(Array.from(selected));
    onClose();
  }, [selected, onAttach, onClose]);

  return (
    <div
      style={{
        position: 'absolute',
        right: 0,
        top: '100%',
        marginTop: 4,
        width: 240,
        backgroundColor: 'var(--bg-elevated)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 8,
        padding: 8,
        zIndex: 20,
        boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
      }}
    >
      {loading ? (
        <span style={{ fontSize: 12, color: 'var(--text-tertiary)', padding: 8 }}>
          Loading servers...
        </span>
      ) : allServers.length === 0 ? (
        <span style={{ fontSize: 12, color: 'var(--text-tertiary)', padding: 8 }}>
          No MCP servers configured.
        </span>
      ) : (
        <>
          <div style={{ maxHeight: 200, overflowY: 'auto' }}>
            {allServers.map((server) => (
              <label
                key={server.name}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 8px',
                  cursor: 'pointer',
                  borderRadius: 4,
                  fontSize: 13,
                  color: 'var(--text-primary)',
                  fontFamily: 'var(--font-mono)',
                }}
              >
                <input
                  type="checkbox"
                  checked={selected.has(server.name)}
                  onChange={() => toggleServer(server.name)}
                  style={{ accentColor: 'var(--accent)' }}
                />
                {server.name}
              </label>
            ))}
          </div>
          <div
            style={{
              display: 'flex',
              justifyContent: 'flex-end',
              gap: 8,
              marginTop: 8,
              paddingTop: 8,
              borderTop: '1px solid var(--border-subtle)',
            }}
          >
            <button
              type="button"
              onClick={onClose}
              style={{
                background: 'none',
                border: '1px solid var(--border-subtle)',
                borderRadius: 4,
                padding: '4px 12px',
                fontSize: 12,
                color: 'var(--text-secondary)',
                cursor: 'pointer',
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              style={{
                background: 'var(--accent)',
                border: 'none',
                borderRadius: 4,
                padding: '4px 12px',
                fontSize: 12,
                color: 'white',
                cursor: 'pointer',
              }}
            >
              Confirm
            </button>
          </div>
        </>
      )}
    </div>
  );
}
