import { useEffect, useState } from 'react';
import type { ConfigGetResponse } from '../../../shared/ipc-contract';
import { RadioOptionRow } from '../../ui/RadioOptionRow';
import { SectionLabel } from '../../ui/SectionLabel';

interface ConnectionTabProps {
  config: ConfigGetResponse;
  onRefresh: () => void;
}

type ConnectionMode = 'local' | 'remote';

interface TestResult {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

export function ConnectionTab({ config: _config, onRefresh }: ConnectionTabProps) {
  const [mode, setMode] = useState<ConnectionMode>('local');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    window.ethos.connection.get().then((res) => {
      setMode(res.mode);
      setUrl(res.url ?? '');
    });
  }, []);

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const req: { url: string; token?: string } = { url };
      if (token) req.token = token;
      const result = await window.ethos.connection.test(req);
      setTestResult(result);
    } catch {
      setTestResult({ ok: false, error: 'Request failed' });
    } finally {
      setTesting(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    try {
      const req: { mode: ConnectionMode; url?: string; token?: string } = { mode };
      if (mode === 'remote') {
        req.url = url;
        if (token) req.token = token;
      }
      await window.ethos.connection.set(req);
      onRefresh();
    } finally {
      setSaving(false);
    }
  }

  const inputStyle: React.CSSProperties = {
    height: 28,
    fontSize: 12,
    borderRadius: 4,
    border: '1px solid var(--border-subtle)',
    backgroundColor: 'transparent',
    color: 'var(--text-primary)',
    padding: '0 8px',
    width: '100%',
    outline: 'none',
  };

  const buttonStyle: React.CSSProperties = {
    height: 28,
    padding: '0 12px',
    borderRadius: 4,
    border: '1px solid var(--border-subtle)',
    backgroundColor: 'transparent',
    color: 'var(--text-primary)',
    fontSize: 12,
    cursor: 'pointer',
  };

  const primaryButtonStyle: React.CSSProperties = {
    height: 28,
    padding: '0 12px',
    borderRadius: 4,
    border: 'none',
    background: 'var(--accent)',
    color: 'white',
    fontSize: 12,
    cursor: 'pointer',
  };

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <SectionLabel>Connection</SectionLabel>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
          <RadioOptionRow selected={mode === 'local'} onClick={() => setMode('local')}>
            <div style={{ flex: 1 }}>
              <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)' }}>
                Local
              </span>
              <div
                style={{
                  fontSize: 12,
                  color: 'var(--text-secondary)',
                  marginTop: 4,
                }}
              >
                Run the Ethos backend on this machine
              </div>
            </div>
          </RadioOptionRow>

          <RadioOptionRow selected={mode === 'remote'} onClick={() => setMode('remote')}>
            <div style={{ flex: 1 }}>
              <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)' }}>
                Remote
              </span>
              <div
                style={{
                  fontSize: 12,
                  color: 'var(--text-secondary)',
                  marginTop: 4,
                }}
              >
                Connect to an Ethos backend running elsewhere
              </div>
            </div>
          </RadioOptionRow>
        </div>
      </div>

      {mode === 'remote' && (
        <div style={{ marginBottom: 24 }}>
          <SectionLabel>Remote Server</SectionLabel>
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <label
                style={{
                  fontSize: 12,
                  color: 'var(--text-secondary)',
                  display: 'block',
                  marginBottom: 4,
                }}
              >
                URL
                <input
                  type="text"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://ethos.example.com"
                  style={{ ...inputStyle, marginTop: 4, display: 'block' }}
                />
              </label>
            </div>

            <div>
              <label
                style={{
                  fontSize: 12,
                  color: 'var(--text-secondary)',
                  display: 'block',
                  marginBottom: 4,
                }}
              >
                Token
                <input
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="Optional authentication token"
                  style={{ ...inputStyle, marginTop: 4, display: 'block' }}
                />
              </label>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button
                type="button"
                onClick={handleTest}
                disabled={testing || !url}
                style={{
                  ...buttonStyle,
                  opacity: testing || !url ? 0.5 : 1,
                }}
              >
                {testing ? 'Testing…' : 'Test Connection'}
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                style={{
                  ...primaryButtonStyle,
                  opacity: saving ? 0.5 : 1,
                }}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>

              {testResult && (
                <span
                  style={{
                    fontSize: 12,
                    color: testResult.ok ? 'var(--success)' : 'var(--error)',
                    marginLeft: 4,
                  }}
                >
                  {testResult.ok
                    ? `✓ Connected (${testResult.latencyMs ?? 0}ms)`
                    : (testResult.error ?? 'Connection failed')}
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
