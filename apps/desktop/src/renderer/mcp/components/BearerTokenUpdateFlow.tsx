import { createEthosClient } from '@ethosagent/sdk';
import { useCallback, useMemo, useState } from 'react';
import { useServerUrl } from '../../shell/ServerUrl';

interface BearerTokenUpdateFlowProps {
  serverName: string;
}

export function BearerTokenUpdateFlow({ serverName }: BearerTokenUpdateFlowProps) {
  const baseUrl = useServerUrl();
  const client = useMemo(() => createEthosClient({ baseUrl, fetch: globalThis.fetch }), [baseUrl]);

  const [editing, setEditing] = useState(false);
  const [token, setToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const handleSave = useCallback(async () => {
    if (!token.trim()) return;
    setSaving(true);
    try {
      await client.rpc.mcp.updateToken({ serverName, token: token.trim() });
      setEditing(false);
      setToken('');
      setFeedback('Token updated ✓');
      setTimeout(() => setFeedback(null), 3000);
    } catch {
      setFeedback('Failed to update token');
      setTimeout(() => setFeedback(null), 3000);
    } finally {
      setSaving(false);
    }
  }, [client, serverName, token]);

  if (feedback && !editing) {
    return (
      <span
        style={{
          fontSize: 13,
          color: feedback.includes('✓') ? 'var(--success)' : 'var(--error)',
        }}
      >
        {feedback}
      </span>
    );
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        style={{
          height: 28,
          padding: '0 10px',
          borderRadius: 4,
          border: '1px solid var(--border-subtle)',
          background: 'none',
          color: 'var(--text-primary)',
          fontSize: 13,
          cursor: 'pointer',
        }}
      >
        Update token
      </button>
    );
  }

  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      <input
        type="password"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleSave();
          if (e.key === 'Escape') {
            setEditing(false);
            setToken('');
          }
        }}
        placeholder="Paste token"
        style={{
          flex: 1,
          height: 28,
          padding: '0 8px',
          borderRadius: 4,
          border: '1px solid var(--border-subtle)',
          background: 'var(--bg-overlay)',
          color: 'var(--text-primary)',
          fontFamily: 'var(--font-mono)',
          fontSize: 13,
          outline: 'none',
        }}
      />
      <button
        type="button"
        onClick={handleSave}
        disabled={saving || !token.trim()}
        style={{
          height: 28,
          padding: '0 10px',
          borderRadius: 4,
          border: '1px solid var(--border-subtle)',
          background: 'none',
          color: 'var(--text-primary)',
          fontSize: 13,
          cursor: saving ? 'not-allowed' : 'pointer',
          opacity: saving || !token.trim() ? 0.5 : 1,
        }}
      >
        {saving ? 'Saving...' : 'Save token'}
      </button>
      {feedback && (
        <span
          style={{
            fontSize: 13,
            color: feedback.includes('✓') ? 'var(--success)' : 'var(--error)',
          }}
        >
          {feedback}
        </span>
      )}
    </div>
  );
}
