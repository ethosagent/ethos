import { createEthosClient } from '@ethosagent/sdk';
import { useEffect, useMemo, useState } from 'react';

interface CharacterSheetDrawerProps {
  personalityId: string;
  open: boolean;
  onClose: () => void;
  port: number;
}

export function CharacterSheetDrawer({
  personalityId,
  open,
  onClose,
  port,
}: CharacterSheetDrawerProps) {
  const client = useMemo(
    () => createEthosClient({ baseUrl: `http://localhost:${port}`, fetch: globalThis.fetch }),
    [port],
  );

  const [markdown, setMarkdown] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) {
      setMarkdown(null);
      return;
    }

    let cancelled = false;
    setLoading(true);

    async function load() {
      try {
        const res = await client.rpc.personalities.characterSheet({ id: personalityId });
        if (!cancelled) setMarkdown(res.markdown);
      } catch {
        if (!cancelled) setMarkdown('Failed to load character sheet.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [open, personalityId, client]);

  if (!open) return null;

  return (
    <>
      {/* biome-ignore lint/a11y/useSemanticElements: overlay backdrop close */}
      <div
        role="button"
        tabIndex={-1}
        onClick={onClose}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onClose();
          }
        }}
        style={{
          position: 'fixed',
          inset: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.3)',
          zIndex: 49,
        }}
      />
      <div
        style={{
          position: 'fixed',
          right: 0,
          top: 0,
          width: 360,
          height: '100vh',
          backgroundColor: 'var(--bg-elevated)',
          borderLeft: '1px solid var(--border-subtle)',
          zIndex: 50,
          display: 'flex',
          flexDirection: 'column',
          transition: 'transform var(--motion-fast) var(--ease)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 16px',
            borderBottom: '1px solid var(--border-subtle)',
          }}
        >
          <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)' }}>
            Character Sheet
          </span>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--text-secondary)',
              fontSize: 18,
              padding: '0 4px',
            }}
          >
            ×
          </button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
          {loading ? (
            <span style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>Loading...</span>
          ) : (
            <pre
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 12,
                color: 'var(--text-secondary)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                margin: 0,
              }}
            >
              {markdown}
            </pre>
          )}
        </div>
      </div>
    </>
  );
}
