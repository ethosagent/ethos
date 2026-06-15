import { useCallback, useEffect, useState } from 'react';
import type { DashboardsClient, Personality, WidgetTemplate } from './types';

interface CreateDashboardFlowProps {
  client: DashboardsClient;
  personalities: Personality[];
  onCreated: (id: string) => void;
  onCancel: () => void;
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  height: 32,
  fontSize: 13,
  backgroundColor: 'var(--bg-base)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 4,
  color: 'var(--text-primary)',
  padding: '0 8px',
  boxSizing: 'border-box',
};

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--text-tertiary)',
  marginBottom: 4,
  display: 'block',
};

const secondaryButtonStyle: React.CSSProperties = {
  height: 28,
  padding: '0 12px',
  background: 'none',
  border: '1px solid var(--border-subtle)',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 13,
  color: 'var(--text-secondary)',
};

const primaryButtonStyle: React.CSSProperties = {
  height: 28,
  padding: '0 12px',
  background: 'none',
  border: '1px solid var(--accent)',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 13,
  color: 'var(--text-primary)',
};

export function CreateDashboardFlow({
  client,
  personalities,
  onCreated,
  onCancel,
}: CreateDashboardFlowProps) {
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [title, setTitle] = useState('');
  const [personalityId, setPersonalityId] = useState(personalities[0]?.id ?? '');
  const [templates, setTemplates] = useState<WidgetTemplate[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const loadTemplates = useCallback(async () => {
    try {
      const res = await client.rpc.dashboards.listWidgetTemplates();
      setTemplates(res.templates);
    } catch {
      // best-effort
    }
  }, [client]);

  useEffect(() => {
    if (step === 1) loadTemplates();
  }, [step, loadTemplates]);

  const toggleTemplate = (id: string) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const selectedTemplates = templates.filter((t) => selectedIds.includes(t.id));
  const personalityName = personalities.find((p) => p.id === personalityId)?.name ?? personalityId;

  const handleCreate = useCallback(async () => {
    try {
      const { dashboard } = await client.rpc.dashboards.create({ title, personalityId });
      for (const t of selectedTemplates) {
        const tplBlock = t.queryType === 'sql' ? 'table' : (t.outputType ?? 'html');
        await client.rpc.dashboards.addPanel({
          dashboardId: dashboard.id,
          panel: {
            queryType: t.queryType === 'sql' ? 'sql' : 'prompt',
            blockType: tplBlock,
            content: '',
            title: t.title,
            sqlQuery: t.sql,
            prompt: t.prompt,
            pluginId: t.pluginId,
            dataSourceId: t.dataSource,
            cronSchedule: t.defaultCron,
          },
        });
      }
      onCreated(dashboard.id);
    } catch {
      // best-effort
    }
  }, [client, title, personalityId, selectedTemplates, onCreated]);

  const canNext = title.trim() !== '' && personalityId !== '';

  return (
    <div style={{ display: 'flex', height: '100%', justifyContent: 'center', overflow: 'auto' }}>
      <div
        style={{
          width: '100%',
          maxWidth: 520,
          margin: '40px auto',
          backgroundColor: 'var(--bg-elevated)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 8,
          padding: 16,
          alignSelf: 'flex-start',
        }}
      >
        <h3 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: 'var(--text-primary)' }}>
          New dashboard
        </h3>

        {step === 0 ? (
          <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <span style={labelStyle}>Title</span>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                style={inputStyle}
                placeholder="My dashboard"
              />
            </div>
            <div>
              <span style={labelStyle}>Personality</span>
              <select
                value={personalityId}
                onChange={(e) => setPersonalityId(e.target.value)}
                style={inputStyle}
              >
                {personalities.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
              <button type="button" onClick={onCancel} style={secondaryButtonStyle}>
                Cancel
              </button>
              <button
                type="button"
                disabled={!canNext}
                onClick={() => setStep(1)}
                style={{ ...primaryButtonStyle, opacity: canNext ? 1 : 0.5 }}
              >
                Next
              </button>
            </div>
          </div>
        ) : null}

        {step === 1 ? (
          <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <span style={labelStyle}>Add widget templates (optional)</span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {templates.map((t) => {
                const selected = selectedIds.includes(t.id);
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => toggleTemplate(t.id)}
                    style={{
                      textAlign: 'left',
                      backgroundColor: 'var(--bg-base)',
                      border: `1px solid ${selected ? 'var(--accent)' : 'var(--border-subtle)'}`,
                      borderRadius: 8,
                      padding: 12,
                      cursor: 'pointer',
                      color: 'var(--text-primary)',
                    }}
                  >
                    <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
                      {t.title}
                    </div>
                    {t.description ? (
                      <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text-tertiary)' }}>
                        {t.description}
                      </div>
                    ) : null}
                  </button>
                );
              })}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
              <button type="button" onClick={() => setStep(0)} style={secondaryButtonStyle}>
                Back
              </button>
              <button
                type="button"
                onClick={() => {
                  setSelectedIds([]);
                  setStep(2);
                }}
                style={secondaryButtonStyle}
              >
                Skip (start empty)
              </button>
              <button type="button" onClick={() => setStep(2)} style={primaryButtonStyle}>
                Next ({selectedIds.length})
              </button>
            </div>
          </div>
        ) : null}

        {step === 2 ? (
          <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <span style={labelStyle}>Title</span>
              <div style={{ fontSize: 13, color: 'var(--text-primary)' }}>{title}</div>
            </div>
            <div>
              <span style={labelStyle}>Personality</span>
              <div style={{ fontSize: 13, color: 'var(--text-primary)' }}>{personalityName}</div>
            </div>
            <div>
              <span style={labelStyle}>Widgets</span>
              {selectedTemplates.length === 0 ? (
                <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>None</div>
              ) : (
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {selectedTemplates.map((t) => (
                    <li key={t.id} style={{ fontSize: 13, color: 'var(--text-primary)' }}>
                      {t.title}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
              <button type="button" onClick={() => setStep(1)} style={secondaryButtonStyle}>
                Back
              </button>
              <button type="button" onClick={handleCreate} style={primaryButtonStyle}>
                Create
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
