import type { createEthosClient } from '@ethosagent/sdk';
import { useState } from 'react';
import { DrawerShell } from '../ui/DrawerShell';
import { RadioOptionRow } from '../ui/RadioOptionRow';
import { SectionLabel } from '../ui/SectionLabel';
import { StatusDot } from '../ui/StatusDot';
import type { McpServer } from './AdminPage';

interface McpServersTabProps {
  client: ReturnType<typeof createEthosClient>;
  mcpServers: McpServer[];
  onReload: () => void;
}

function statusDisplay(status: McpServer['status']): { color: string; text: string } {
  if (status === 'connected') return { color: 'var(--success)', text: 'Connected' };
  if (status === 'error') return { color: 'var(--error)', text: 'Error' };
  return { color: 'var(--text-tertiary)', text: 'Disconnected' };
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

export function McpServersTab({ client, mcpServers, onReload }: McpServersTabProps) {
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [addOpen, setAddOpen] = useState(false);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [authType, setAuthType] = useState<'none' | 'bearer' | 'oauth'>('none');
  const [submitting, setSubmitting] = useState(false);

  async function handleRemove(serverName: string) {
    const confirmed = await window.ethos.dialog.showMessage({
      type: 'warning',
      message: `Remove "${serverName}"? This action cannot be undone.`,
      buttons: ['Cancel', 'Remove'],
    });
    if (confirmed.response !== 1) return;
    setPending((prev) => new Set(prev).add(serverName));
    try {
      await client.rpc.admin.removeMcpServer({ name: serverName });
      onReload();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await window.ethos.dialog.showMessage({ type: 'warning', message: msg, buttons: ['OK'] });
    } finally {
      setPending((prev) => {
        const next = new Set(prev);
        next.delete(serverName);
        return next;
      });
    }
  }

  function resetAndClose() {
    setAddOpen(false);
    setName('');
    setUrl('');
    setAuthType('none');
  }

  async function handleAdd() {
    if (!name.trim() || !url.trim()) return;
    setSubmitting(true);
    try {
      await client.rpc.admin.addMcpServer({ name: name.trim(), url: url.trim(), authType });
      resetAndClose();
      onReload();
      await window.ethos.dialog.showMessage({
        type: 'info',
        message: 'MCP server added',
        buttons: ['OK'],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await window.ethos.dialog.showMessage({ type: 'warning', message: msg, buttons: ['OK'] });
    } finally {
      setSubmitting(false);
    }
  }

  const canAdd = name.trim().length > 0 && url.trim().length > 0 && !submitting;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div
        style={{
          height: 40,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          padding: '8px 24px 0',
          flexShrink: 0,
        }}
      >
        <button
          type="button"
          onClick={() => setAddOpen(true)}
          style={{
            height: 28,
            padding: '0 12px',
            borderRadius: 4,
            border: '1px solid rgba(74, 158, 255, 0.3)',
            background: 'rgba(74, 158, 255, 0.1)',
            color: 'var(--accent)',
            fontSize: 12,
            cursor: 'pointer',
            fontFamily: 'var(--font-display)',
            whiteSpace: 'nowrap',
          }}
        >
          + Add MCP Server
        </button>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '0 24px' }}>
        {mcpServers.length === 0 ? (
          <div style={{ paddingTop: 48, textAlign: 'center' }}>
            <div style={{ fontSize: 14, color: 'var(--text-secondary)' }}>
              No MCP servers configured.
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
              <div style={{ ...columnHeaderStyle, flex: 1 }}>Name</div>
              <div style={{ ...columnHeaderStyle, width: 140 }}>Status</div>
              <div style={{ ...columnHeaderStyle, width: 80 }}>Tools</div>
              <div style={{ ...columnHeaderStyle, width: 100 }}>Actions</div>
            </div>
            {mcpServers.map((s) => {
              const sd = statusDisplay(s.status);
              return (
                <div
                  key={s.name}
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
                      fontFamily: 'var(--font-mono)',
                      fontSize: 13,
                      color: 'var(--text-primary)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {s.name}
                  </div>
                  <div style={{ width: 140, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <StatusDot color={sd.color} />
                    <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{sd.text}</span>
                  </div>
                  <div
                    style={{
                      width: 80,
                      fontFamily: 'var(--font-mono)',
                      fontSize: 12,
                      color: s.toolCount != null ? 'var(--text-secondary)' : 'var(--text-tertiary)',
                    }}
                  >
                    {s.toolCount != null ? String(s.toolCount) : '-'}
                  </div>
                  <div style={{ width: 100 }}>
                    <button
                      type="button"
                      disabled={pending.has(s.name)}
                      onClick={() => handleRemove(s.name)}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: 'var(--error)',
                        fontSize: 12,
                        cursor: pending.has(s.name) ? 'not-allowed' : 'pointer',
                        padding: 0,
                        opacity: pending.has(s.name) ? 0.5 : 1,
                      }}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              );
            })}
          </>
        )}
      </div>
      <DrawerShell
        open={addOpen}
        title="Add MCP Server"
        onClose={resetAndClose}
        footer={
          <button
            type="button"
            disabled={!canAdd}
            onClick={handleAdd}
            style={{
              ...filledButtonStyle,
              opacity: canAdd ? 1 : 0.4,
              cursor: canAdd ? 'pointer' : 'not-allowed',
            }}
          >
            Add
          </button>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <SectionLabel>Name</SectionLabel>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={inputStyle}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <SectionLabel>URL</SectionLabel>
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              style={inputStyle}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <SectionLabel>Auth type</SectionLabel>
            <RadioOptionRow selected={authType === 'none'} onClick={() => setAuthType('none')}>
              <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>None</span>
            </RadioOptionRow>
            <RadioOptionRow selected={authType === 'bearer'} onClick={() => setAuthType('bearer')}>
              <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>Bearer</span>
            </RadioOptionRow>
            <RadioOptionRow selected={authType === 'oauth'} onClick={() => setAuthType('oauth')}>
              <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>OAuth</span>
            </RadioOptionRow>
          </div>
        </div>
      </DrawerShell>
    </div>
  );
}
