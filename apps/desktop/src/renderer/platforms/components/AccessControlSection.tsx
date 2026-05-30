import type { createEthosClient } from '@ethosagent/sdk';
import { useCallback, useEffect, useState } from 'react';
import { Toggle } from '../../ui/Toggle';

interface AccessControlSectionProps {
  platform: string;
  client: ReturnType<typeof createEthosClient>;
}

const PLATFORM_HINTS: Record<string, string> = {
  telegram: 'Send /start to @userinfobot. The number shown is your user ID.',
  slack: 'Open your Slack profile → click the … menu → "Copy member ID".',
  discord: 'Enable Developer Mode → right-click your name → "Copy User ID".',
  email: "Use the sender's full email address (globs supported: *@example.com).",
  whatsapp: 'Your WhatsApp phone number in E.164 format (e.g., +14155551234).',
};

const microLabel: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: 'var(--text-tertiary)',
  marginBottom: 8,
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  height: 36,
  fontFamily: 'var(--font-mono)',
  fontSize: 13,
  color: 'var(--text-primary)',
  backgroundColor: 'var(--bg-elevated)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 4,
  padding: '0 10px',
  outline: 'none',
};

const labelStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--text-secondary)',
  marginBottom: 4,
};

export function AccessControlSection({ platform, client }: AccessControlSectionProps) {
  const [enabled, setEnabled] = useState(false);
  const [ownerUserId, setOwnerUserId] = useState('');
  const [allowlist, setAllowlist] = useState<string[]>([]);
  const [newId, setNewId] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const loadFilter = useCallback(async () => {
    try {
      const result = await client.rpc.platforms.getChannelFilter({ platform });
      const f = result.filter;
      setEnabled(f.enabled);
      setOwnerUserId(f.ownerUserId);
      setAllowlist(f.allowlist);
    } catch {
      // Backend may not support this yet — leave defaults
    } finally {
      setLoading(false);
    }
  }, [client, platform]);

  useEffect(() => {
    loadFilter();
  }, [loadFilter]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const result = await client.rpc.platforms.setChannelFilter({
        platform,
        filter: { enabled, ownerUserId, allowlist },
      });
      const f = result.filter;
      setEnabled(f.enabled);
      setOwnerUserId(f.ownerUserId);
      setAllowlist(f.allowlist);
      setSaved(true);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }, [client, platform, enabled, ownerUserId, allowlist]);

  const handleAddId = useCallback(() => {
    const trimmed = newId.trim();
    if (!trimmed || allowlist.includes(trimmed)) return;
    setAllowlist((prev) => [...prev, trimmed]);
    setNewId('');
    setSaved(false);
  }, [newId, allowlist]);

  const handleRemoveId = useCallback((id: string) => {
    setAllowlist((prev) => prev.filter((v) => v !== id));
    setSaved(false);
  }, []);

  if (loading) return null;

  const hint = PLATFORM_HINTS[platform] ?? '';

  return (
    <div>
      <div style={microLabel}>ACCESS CONTROL</div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <Toggle
          checked={enabled}
          onChange={(v) => {
            setEnabled(v);
            setSaved(false);
          }}
        />
        <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
          Restrict to specific users
        </span>
      </div>

      {enabled && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <div style={labelStyle}>Owner user ID</div>
            <input
              type="text"
              value={ownerUserId}
              onChange={(e) => {
                setOwnerUserId(e.target.value);
                setSaved(false);
              }}
              placeholder="Owner ID"
              style={inputStyle}
            />
          </div>

          {hint && (
            <div
              style={{
                fontSize: 12,
                color: 'var(--text-secondary)',
                backgroundColor: 'var(--bg-elevated)',
                borderRadius: 8,
                padding: 12,
                lineHeight: 1.5,
              }}
            >
              {hint}
            </div>
          )}

          <div>
            <div style={labelStyle}>Additional allowed users</div>
            {allowlist.length > 0 && (
              <div
                style={{
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 4,
                  overflow: 'hidden',
                  marginBottom: 8,
                }}
              >
                {allowlist.map((id) => (
                  <div
                    key={id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      height: 36,
                      padding: '0 12px',
                      borderBottom: '1px solid var(--border-subtle)',
                    }}
                  >
                    <span
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 13,
                        color: 'var(--text-primary)',
                      }}
                    >
                      {id}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleRemoveId(id)}
                      style={{
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        fontSize: 16,
                        color: 'var(--text-tertiary)',
                        padding: '0 4px',
                        lineHeight: 1,
                      }}
                    >
                      {'×'}
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type="text"
                value={newId}
                onChange={(e) => setNewId(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleAddId();
                }}
                placeholder="Add user ID"
                style={{ ...inputStyle, flex: 1 }}
              />
              <button
                type="button"
                onClick={handleAddId}
                disabled={!newId.trim()}
                style={{
                  height: 36,
                  borderRadius: 4,
                  border: '1px solid var(--border-subtle)',
                  background: 'none',
                  color: 'var(--text-secondary)',
                  fontSize: 12,
                  padding: '0 12px',
                  cursor: !newId.trim() ? 'not-allowed' : 'pointer',
                  opacity: !newId.trim() ? 0.5 : 1,
                  whiteSpace: 'nowrap',
                  flexShrink: 0,
                }}
              >
                Add
              </button>
            </div>
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={handleSave}
        disabled={saving}
        style={{
          width: '100%',
          height: 36,
          borderRadius: 4,
          border: 'none',
          backgroundColor: 'var(--accent)',
          color: '#fff',
          fontSize: 13,
          fontWeight: 500,
          cursor: saving ? 'not-allowed' : 'pointer',
          opacity: saving ? 0.7 : 1,
          marginTop: 12,
        }}
      >
        {saving ? 'Saving...' : 'Save access control'}
      </button>

      {saveError && <div style={{ fontSize: 12, color: 'var(--error)' }}>{saveError}</div>}

      {saved && (
        <div
          style={{
            fontSize: 12,
            color: 'var(--text-secondary)',
            backgroundColor: 'var(--bg-elevated)',
            borderRadius: 8,
            padding: 12,
            lineHeight: 1.5,
          }}
        >
          Restart the gateway (or re-run <code>ethos serve</code>) to apply changes.
        </div>
      )}
    </div>
  );
}
