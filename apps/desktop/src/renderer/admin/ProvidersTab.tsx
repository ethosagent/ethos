import type { createEthosClient } from '@ethosagent/sdk';
import { useState } from 'react';
import { Chip } from '../ui/Chip';
import { DrawerShell } from '../ui/DrawerShell';
import { SectionLabel } from '../ui/SectionLabel';
import type { Provider } from './AdminPage';

interface ProvidersTabProps {
  client: ReturnType<typeof createEthosClient>;
  providers: Provider[];
  onReload: () => void;
}

const columnHeaderStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 500,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--text-tertiary)',
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  height: 36,
  fontFamily: 'var(--font-mono)',
  fontSize: 13,
  padding: '0 10px',
  backgroundColor: 'var(--bg-elevated)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 4,
  color: 'var(--text-primary)',
  outline: 'none',
  boxSizing: 'border-box',
};

const filledButtonStyle: React.CSSProperties = {
  height: 28,
  padding: '0 14px',
  borderRadius: 4,
  border: 'none',
  backgroundColor: 'var(--text-primary)',
  color: 'var(--bg-base)',
  fontSize: 13,
  fontWeight: 500,
  cursor: 'pointer',
};

export function ProvidersTab({ client, providers, onReload }: ProvidersTabProps) {
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [rotateProvider, setRotateProvider] = useState<Provider | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleCheck(p: Provider) {
    setPending((prev) => new Set(prev).add(p.id));
    try {
      const data = await client.rpc.admin.checkProvider({ provider: p.id });
      onReload();
      await window.ethos.dialog.showMessage({
        type: data.ok ? 'info' : 'warning',
        message: data.ok
          ? `Provider healthy (${data.latencyMs}ms)`
          : `Provider check failed (${data.latencyMs}ms)`,
        buttons: ['OK'],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await window.ethos.dialog.showMessage({ type: 'warning', message: msg, buttons: ['OK'] });
    } finally {
      setPending((prev) => {
        const next = new Set(prev);
        next.delete(p.id);
        return next;
      });
    }
  }

  async function handleRotate() {
    if (!rotateProvider || !keyInput.trim()) return;
    setSubmitting(true);
    try {
      await client.rpc.admin.rotateKey({ provider: rotateProvider.id, key: keyInput.trim() });
      setRotateProvider(null);
      setKeyInput('');
      onReload();
      await window.ethos.dialog.showMessage({
        type: 'info',
        message: 'Key rotated',
        buttons: ['OK'],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await window.ethos.dialog.showMessage({ type: 'warning', message: msg, buttons: ['OK'] });
    } finally {
      setSubmitting(false);
    }
  }

  function closeRotate() {
    setRotateProvider(null);
    setKeyInput('');
  }

  const canRotate = keyInput.trim().length > 0 && !submitting;

  return (
    <>
      <div style={{ height: '100%', overflow: 'auto', padding: '0 24px' }}>
        {providers.length === 0 ? (
          <div style={{ paddingTop: 48, textAlign: 'center' }}>
            <div style={{ fontSize: 14, color: 'var(--text-secondary)' }}>
              No providers configured.
            </div>
          </div>
        ) : (
          <>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                height: 32,
                borderBottom: '1px solid var(--border-subtle)',
              }}
            >
              <div style={{ ...columnHeaderStyle, flex: 1 }}>Provider</div>
              <div style={{ ...columnHeaderStyle, width: 120 }}>API Key</div>
              <div style={{ ...columnHeaderStyle, width: 160 }}>Health</div>
              <div style={{ ...columnHeaderStyle, width: 160 }}>Actions</div>
            </div>
            {providers.map((p) => (
              <div
                key={p.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  height: 44,
                  borderBottom: '1px solid var(--border-subtle)',
                }}
              >
                <div
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: 13,
                    color: 'var(--text-primary)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {p.name}
                </div>
                <div style={{ width: 120 }}>
                  <Chip
                    variant={p.hasKey ? 'success' : 'neutral'}
                    label={p.hasKey ? 'Configured' : 'Missing'}
                  />
                </div>
                <div style={{ width: 160 }}>
                  {p.healthy === undefined ? (
                    <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>Unknown</span>
                  ) : p.healthy ? (
                    <Chip
                      variant="success"
                      label={p.latencyMs != null ? `Healthy (${p.latencyMs}ms)` : 'Healthy'}
                    />
                  ) : (
                    <Chip variant="error" label="Unhealthy" />
                  )}
                </div>
                <div style={{ width: 160, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <button
                    type="button"
                    disabled={pending.has(p.id)}
                    onClick={() => handleCheck(p)}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: 'var(--info)',
                      fontSize: 12,
                      cursor: pending.has(p.id) ? 'not-allowed' : 'pointer',
                      padding: 0,
                      opacity: pending.has(p.id) ? 0.5 : 1,
                    }}
                  >
                    Check
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setRotateProvider(p);
                      setKeyInput('');
                    }}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: 'var(--info)',
                      fontSize: 12,
                      cursor: 'pointer',
                      padding: 0,
                    }}
                  >
                    Rotate key
                  </button>
                </div>
              </div>
            ))}
          </>
        )}
      </div>
      <DrawerShell
        open={rotateProvider !== null}
        title={`Rotate key — ${rotateProvider?.name ?? ''}`}
        onClose={closeRotate}
        footer={
          <button
            type="button"
            disabled={!canRotate}
            onClick={handleRotate}
            style={{
              ...filledButtonStyle,
              opacity: canRotate ? 1 : 0.4,
              cursor: canRotate ? 'pointer' : 'not-allowed',
            }}
          >
            Rotate
          </button>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <SectionLabel>New API key</SectionLabel>
          <input
            type="password"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            style={inputStyle}
          />
        </div>
      </DrawerShell>
    </>
  );
}
