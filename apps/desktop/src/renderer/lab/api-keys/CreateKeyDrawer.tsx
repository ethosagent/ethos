import { useCallback, useState } from 'react';
import { DrawerShell } from '../../ui/DrawerShell';

interface CreateKeyDrawerProps {
  open: boolean;
  onClose: () => void;
  onCreate: (params: { name: string; scopes: string[]; allowedOrigins: string[] }) => void;
}

const SCOPE_OPTIONS = [
  { value: 'sessions:read', label: 'sessions:read', desc: 'Read session data' },
  { value: 'sessions:write', label: 'sessions:write', desc: 'Create and modify sessions' },
  { value: 'chat:send', label: 'chat:send', desc: 'Send messages to agents' },
  {
    value: 'personalities:read',
    label: 'personalities:read',
    desc: 'List and read personalities',
  },
  { value: 'memory:read', label: 'memory:read', desc: 'Read memory data' },
  { value: 'memory:write', label: 'memory:write', desc: 'Write memory data' },
  { value: 'tools:approve', label: 'tools:approve', desc: 'Approve tool calls' },
  { value: 'events:subscribe', label: 'events:subscribe', desc: 'Subscribe to SSE events' },
] as const;

type ExpiryOption = 'never' | '30d' | '90d' | '1y' | 'custom';

function _computeExpiresAt(option: ExpiryOption, customDate: string): string | undefined {
  if (option === 'never') return undefined;
  if (option === 'custom') return customDate || undefined;
  const now = new Date();
  const days = option === '30d' ? 30 : option === '90d' ? 90 : 365;
  now.setDate(now.getDate() + days);
  return now.toISOString().slice(0, 10);
}

export function CreateKeyDrawer({ open, onClose, onCreate }: CreateKeyDrawerProps) {
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>([]);
  const [origins, setOrigins] = useState<string[]>([]);
  const [originInput, setOriginInput] = useState('');
  const [expiry, setExpiry] = useState<ExpiryOption>('never');
  const [customDate, setCustomDate] = useState('');

  const toggleScope = useCallback((scope: string) => {
    setScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope],
    );
  }, []);

  const handleOriginKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const value = originInput.trim();
        if (value && !origins.includes(value)) {
          setOrigins((prev) => [...prev, value]);
        }
        setOriginInput('');
      }
    },
    [originInput, origins],
  );

  const removeOrigin = useCallback((origin: string) => {
    setOrigins((prev) => prev.filter((o) => o !== origin));
  }, []);

  const handleSubmit = useCallback(() => {
    if (!name.trim()) return;
    onCreate({
      name: name.trim(),
      scopes,
      allowedOrigins: origins,
    });
    setName('');
    setScopes([]);
    setOrigins([]);
    setOriginInput('');
    setExpiry('never');
    setCustomDate('');
    onClose();
  }, [name, scopes, origins, onCreate, onClose]);

  return (
    <DrawerShell
      open={open}
      title="Create API Key"
      onClose={onClose}
      footer={
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!name.trim()}
          style={{
            height: 36,
            width: '100%',
            borderRadius: 4,
            border: 'none',
            background: name.trim() ? 'var(--accent)' : 'var(--bg-overlay)',
            color: name.trim() ? '#fff' : 'var(--text-tertiary)',
            fontSize: 13,
            fontWeight: 600,
            cursor: name.trim() ? 'pointer' : 'default',
          }}
        >
          Create key
        </button>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div>
          <div style={labelStyle}>Name</div>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Colleague access key"
            style={inputStyle}
          />
        </div>

        <div>
          <div style={labelStyle}>Scopes</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {SCOPE_OPTIONS.map((opt) => (
              <label
                key={opt.value}
                style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer' }}
              >
                <input
                  type="checkbox"
                  checked={scopes.includes(opt.value)}
                  onChange={() => toggleScope(opt.value)}
                  style={{ marginTop: 2, width: 14, height: 14, flexShrink: 0 }}
                />
                <div>
                  <div style={{ fontSize: 13, color: 'var(--text-primary)' }}>{opt.label}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{opt.desc}</div>
                </div>
              </label>
            ))}
          </div>
        </div>

        <div>
          <div style={labelStyle}>Allowed origins</div>
          {origins.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
              {origins.map((origin) => (
                <span key={origin} style={pillStyle}>
                  {origin}
                  <button
                    type="button"
                    onClick={() => removeOrigin(origin)}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: 'var(--text-tertiary)',
                      cursor: 'pointer',
                      padding: '0 0 0 4px',
                      fontSize: 12,
                      lineHeight: 1,
                    }}
                  >
                    &times;
                  </button>
                </span>
              ))}
            </div>
          )}
          <input
            value={originInput}
            onChange={(e) => setOriginInput(e.target.value)}
            onKeyDown={handleOriginKeyDown}
            placeholder="https://example.com — or * for any"
            style={{ ...inputStyle, fontFamily: 'var(--font-mono)' }}
          />
        </div>

        <div>
          <div style={labelStyle}>Expiry</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
            {(
              [
                ['never', 'Never'],
                ['30d', '30 days'],
                ['90d', '90 days'],
                ['1y', '1 year'],
                ['custom', 'Custom date'],
              ] as const
            ).map(([value, label]) => (
              <label
                key={value}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  height: 32,
                  cursor: 'pointer',
                }}
              >
                <input
                  type="radio"
                  name="expiry"
                  checked={expiry === value}
                  onChange={() => setExpiry(value)}
                  style={{ width: 14, height: 14, flexShrink: 0 }}
                />
                <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>{label}</span>
              </label>
            ))}
            {expiry === 'custom' && (
              <input
                type="date"
                value={customDate}
                onChange={(e) => setCustomDate(e.target.value)}
                style={{ ...inputStyle, marginTop: 8, width: 180 }}
              />
            )}
          </div>
        </div>
      </div>
    </DrawerShell>
  );
}

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 11,
  fontWeight: 500,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  color: 'var(--text-tertiary)',
  marginBottom: 6,
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  height: 36,
  fontSize: 14,
  color: 'var(--text-primary)',
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 4,
  padding: '0 10px',
  outline: 'none',
  boxSizing: 'border-box',
};

const pillStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  background: 'var(--bg-overlay)',
  borderRadius: 4,
  padding: '6px 8px',
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  color: 'var(--text-primary)',
};
