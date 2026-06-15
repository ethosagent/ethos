import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dashboard, DashboardsClient, Personality, WidgetTemplate } from './types';

interface DashboardListProps {
  client: DashboardsClient;
  personalities: Personality[];
  defaultPersonalityId: string;
  onOpen: (id: string) => void;
  onCreate: () => void;
  onImported: (id: string) => void;
}

const headerButtonStyle: React.CSSProperties = {
  height: 28,
  padding: '0 12px',
  background: 'none',
  border: '1px solid var(--border-subtle)',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 13,
  color: 'var(--text-secondary)',
};

function DashboardCard({
  dashboard,
  onOpen,
  onDelete,
}: {
  dashboard: Dashboard;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    // biome-ignore lint/a11y/useSemanticElements: container holds a nested button
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(dashboard.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(dashboard.id);
        }
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        backgroundColor: 'var(--bg-elevated)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 8,
        padding: 16,
        cursor: 'pointer',
        transition: 'border-color var(--motion-fast) var(--ease)',
        borderColor: hovered ? 'var(--text-tertiary)' : 'var(--border-subtle)',
        position: 'relative',
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)' }}>
        {dashboard.title}
      </div>
      <div
        style={{
          marginTop: 8,
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          color: 'var(--text-secondary)',
        }}
      >
        {dashboard.personalityId}
      </div>
      <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text-tertiary)' }}>
        {new Date(dashboard.createdAt).toLocaleDateString()}
      </div>
      <button
        type="button"
        title="Delete"
        onClick={(e) => {
          e.stopPropagation();
          onDelete(dashboard.id);
        }}
        style={{
          position: 'absolute',
          top: 12,
          right: 12,
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          fontSize: 16,
          color: 'var(--text-secondary)',
          padding: 0,
          lineHeight: 1,
          opacity: hovered ? 1 : 0,
          transition: 'opacity var(--motion-fast) var(--ease)',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = 'var(--error)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = 'var(--text-secondary)';
        }}
      >
        🗑
      </button>
    </div>
  );
}

export function DashboardList({
  client,
  personalities,
  defaultPersonalityId,
  onOpen,
  onCreate,
  onImported,
}: DashboardListProps) {
  const [dashboards, setDashboards] = useState<Dashboard[]>([]);
  const [templates, setTemplates] = useState<WidgetTemplate[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    try {
      const res = await client.rpc.dashboards.list();
      setDashboards(res.dashboards);
    } catch {
      // best-effort
    }
  }, [client]);

  const loadTemplates = useCallback(async () => {
    try {
      const res = await client.rpc.dashboards.listWidgetTemplates();
      setTemplates(res.templates);
    } catch {
      // best-effort
    }
  }, [client]);

  useEffect(() => {
    reload();
    loadTemplates();
  }, [reload, loadTemplates]);

  const handleDelete = useCallback(
    async (id: string) => {
      const confirmed = await window.ethos.dialog.showMessage({
        type: 'warning',
        message: 'Delete this dashboard?',
        buttons: ['Cancel', 'Delete'],
      });
      if (confirmed.response !== 1) return;
      try {
        await client.rpc.dashboards.delete({ id });
        await reload();
      } catch {
        // best-effort
      }
    },
    [client, reload],
  );

  const handleImportChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const res = await client.rpc.dashboards.importDashboard({ exportJson: text });
        onImported(res.dashboardId);
      } catch {
        // best-effort
      } finally {
        e.target.value = '';
      }
    },
    [client, onImported],
  );

  const resolvedPersonalityId = defaultPersonalityId || (personalities[0]?.id ?? '');

  const handleTemplateClick = useCallback(
    async (template: WidgetTemplate) => {
      const pid = resolvedPersonalityId;
      if (!pid) return;
      const tplBlock = template.queryType === 'sql' ? 'table' : (template.outputType ?? 'html');
      try {
        const res = await client.rpc.dashboards.addPanel({
          dashboardId: null,
          newDashboardTitle: template.title,
          personalityId: pid,
          panel: {
            queryType: template.queryType === 'sql' ? 'sql' : 'prompt',
            blockType: tplBlock,
            content: '',
            title: template.title,
            sqlQuery: template.sql,
            prompt: template.prompt,
            pluginId: template.pluginId,
            dataSourceId: template.dataSource,
            cronSchedule: template.defaultCron,
          },
        });
        onOpen(res.panel.dashboardId);
      } catch {
        // best-effort
      }
    },
    [client, resolvedPersonalityId, onOpen],
  );

  const templatesEnabled = resolvedPersonalityId !== '';

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            height: 40,
            padding: '0 16px',
            flexShrink: 0,
          }}
        >
          <h3 style={{ margin: 0, fontSize: 20, fontWeight: 600, color: 'var(--text-primary)' }}>
            Dashboards
          </h3>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              style={headerButtonStyle}
            >
              Import
            </button>
            <button type="button" onClick={onCreate} style={headerButtonStyle}>
              Create
            </button>
          </div>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: '0 16px' }}>
          {dashboards.length === 0 ? (
            <div style={{ marginTop: 40, fontSize: 14, color: 'var(--text-tertiary)' }}>
              No dashboards yet. Create one or pick a widget template below.
            </div>
          ) : (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
                gap: 16,
                marginTop: 16,
              }}
            >
              {dashboards.map((dashboard) => (
                <DashboardCard
                  key={dashboard.id}
                  dashboard={dashboard}
                  onOpen={onOpen}
                  onDelete={handleDelete}
                />
              ))}
            </div>
          )}

          {templates.length > 0 ? (
            <div style={{ marginTop: 32, marginBottom: 16 }}>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: 'var(--text-secondary)',
                  marginBottom: 8,
                }}
              >
                Widget templates
              </div>
              {!templatesEnabled ? (
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 8 }}>
                  Add a personality to use templates
                </div>
              ) : null}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
                  gap: 12,
                }}
              >
                {templates.map((template) => (
                  <button
                    key={template.id}
                    type="button"
                    disabled={!templatesEnabled}
                    onClick={() => handleTemplateClick(template)}
                    style={{
                      textAlign: 'left',
                      backgroundColor: 'var(--bg-elevated)',
                      border: '1px solid var(--border-subtle)',
                      borderRadius: 8,
                      padding: 12,
                      cursor: templatesEnabled ? 'pointer' : 'default',
                      opacity: templatesEnabled ? 1 : 0.5,
                      color: 'var(--text-primary)',
                    }}
                  >
                    <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
                      {template.title}
                    </div>
                    {template.description ? (
                      <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text-tertiary)' }}>
                        {template.description}
                      </div>
                    ) : null}
                    <div
                      style={{
                        marginTop: 6,
                        fontFamily: 'var(--font-mono)',
                        fontSize: 10,
                        color: 'var(--text-tertiary)',
                      }}
                    >
                      {template.queryType}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="application/json"
        onChange={handleImportChange}
        style={{ display: 'none' }}
      />
    </div>
  );
}
