import { createEthosClient } from '@ethosagent/sdk';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAppState } from '../state/AppContext';
import { SectionLabel } from '../ui/SectionLabel';
import { PluginHomeDrawer } from './PluginHomeDrawer';
import { PluginSettingsDrawer } from './PluginSettingsDrawer';

// ---------------------------------------------------------------------------
// Types mirroring web-contracts schemas
// ---------------------------------------------------------------------------

interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description: string | null;
  source: 'user' | 'project' | 'npm';
  path: string;
  pluginContractMajor: number | null;
  hasHomePanel?: boolean;
}

interface PageSection {
  type: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  label: string;
  columns?: string[];
  chartType?: string;
  dataField?: string;
  valueField?: string;
  unit?: string;
  maxItems?: number;
  autoRefreshMs?: number;
}

interface PageSpec {
  title: string;
  icon?: string;
  sections: PageSection[];
  showInSidebar?: boolean;
}

interface ToolForPageResult {
  ok: boolean;
  value: string;
  structured?: Record<string, unknown>;
  error?: string;
}

// ---------------------------------------------------------------------------
// Top-level page
// ---------------------------------------------------------------------------

export function PluginsPage() {
  const { state } = useAppState();
  const { port } = state;

  const client = useMemo(
    () => createEthosClient({ baseUrl: `http://localhost:${port}`, fetch: globalThis.fetch }),
    [port],
  );

  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [pageSpecs, setPageSpecs] = useState<Map<string, PageSpec>>(new Map());
  const [selectedPluginId, setSelectedPluginId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [homeDrawerPlugin, setHomeDrawerPlugin] = useState<PluginInfo | null>(null);
  const [settingsDrawerPlugin, setSettingsDrawerPlugin] = useState<PluginInfo | null>(null);

  // Fetch plugin list
  useEffect(() => {
    let stale = false;
    setLoading(true);
    client.rpc.plugins
      .list({})
      .then((res: { plugins: PluginInfo[] }) => {
        if (!stale) setPlugins(res.plugins);
      })
      .catch(() => {})
      .finally(() => {
        if (!stale) setLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [client]);

  // Fetch page specs for all plugins
  useEffect(() => {
    if (plugins.length === 0) return;
    let stale = false;
    const specs = new Map<string, PageSpec>();

    Promise.allSettled(
      plugins.map((p) =>
        client.rpc.plugins.getPageSpec({ pluginId: p.id }).then((res) => {
          if (res.spec) specs.set(p.id, res.spec as unknown as PageSpec);
        }),
      ),
    ).then(() => {
      if (!stale) setPageSpecs(new Map(specs));
    });

    return () => {
      stale = true;
    };
  }, [client, plugins]);

  const handleBack = useCallback(() => setSelectedPluginId(null), []);

  // When a plugin is selected, show its dedicated page
  if (selectedPluginId) {
    const spec = pageSpecs.get(selectedPluginId);
    const plugin = plugins.find((p) => p.id === selectedPluginId);
    if (!spec || !plugin) {
      return (
        <div style={{ padding: 24 }}>
          <button type="button" onClick={handleBack} style={backButtonStyle}>
            ← Back
          </button>
          <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>
            No page spec found for this plugin.
          </p>
        </div>
      );
    }
    return (
      <PluginPageView pluginId={selectedPluginId} spec={spec} client={client} onBack={handleBack} />
    );
  }

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        padding: '0 24px',
      }}
    >
      <div
        style={{
          height: 40,
          display: 'flex',
          alignItems: 'center',
          flexShrink: 0,
          paddingTop: 8,
        }}
      >
        <h3
          style={{
            margin: 0,
            fontSize: 20,
            fontWeight: 600,
            color: 'var(--text-primary)',
          }}
        >
          Plugins
        </h3>
      </div>

      <div style={{ flex: 1, overflow: 'auto', paddingTop: 12 }}>
        {loading ? (
          <p style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>Loading plugins...</p>
        ) : plugins.length === 0 ? (
          <div>
            <p style={{ color: 'var(--text-tertiary)', fontSize: 14 }}>No plugins installed.</p>
            <p style={{ color: 'var(--text-secondary)', fontSize: 12, marginTop: 4 }}>
              Install plugins via Skills → Plugins or the CLI.
            </p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* Plugins with pages */}
            {pluginsWithPages(plugins, pageSpecs).length > 0 && (
              <div>
                <SectionLabel>PLUGIN PAGES</SectionLabel>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
                    gap: 8,
                    marginTop: 8,
                  }}
                >
                  {pluginsWithPages(plugins, pageSpecs).map(({ plugin, spec }) => (
                    <PluginCard
                      key={plugin.id}
                      plugin={plugin}
                      spec={spec}
                      onClick={() => setSelectedPluginId(plugin.id)}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* All installed plugins */}
            <div>
              <SectionLabel>ALL INSTALLED</SectionLabel>
              <div
                style={{
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius-sm)',
                  overflow: 'hidden',
                  marginTop: 8,
                }}
              >
                {plugins.map((plugin) => (
                  <PluginListRow
                    key={plugin.id}
                    plugin={plugin}
                    hasPage={pageSpecs.has(plugin.id)}
                    onOpen={() => setSelectedPluginId(plugin.id)}
                    onOpenHome={() => setHomeDrawerPlugin(plugin)}
                    onOpenSettings={() => setSettingsDrawerPlugin(plugin)}
                  />
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {homeDrawerPlugin && (
        <PluginHomeDrawer
          pluginId={homeDrawerPlugin.id}
          pluginPath={homeDrawerPlugin.path}
          theme="dark"
          onClose={() => setHomeDrawerPlugin(null)}
        />
      )}

      {settingsDrawerPlugin && (
        <PluginSettingsDrawer
          pluginId={settingsDrawerPlugin.id}
          name={settingsDrawerPlugin.name}
          version={settingsDrawerPlugin.version}
          description={settingsDrawerPlugin.description ?? undefined}
          credentials={[]}
          tools={[]}
          theme="dark"
          onClose={() => setSettingsDrawerPlugin(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pluginsWithPages(
  plugins: PluginInfo[],
  specs: Map<string, PageSpec>,
): { plugin: PluginInfo; spec: PageSpec }[] {
  const result: { plugin: PluginInfo; spec: PageSpec }[] = [];
  for (const plugin of plugins) {
    const spec = specs.get(plugin.id);
    if (spec) result.push({ plugin, spec });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Plugin card (for plugins that registered a page)
// ---------------------------------------------------------------------------

function PluginCard({
  plugin,
  spec,
  onClick,
}: {
  plugin: PluginInfo;
  spec: PageSpec;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: '12px 16px',
        backgroundColor: 'var(--bg-elevated)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-md)',
        cursor: 'pointer',
        textAlign: 'left',
        transition: `border-color var(--motion-fast) var(--ease)`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {spec.icon && <span style={{ fontSize: 18 }}>{spec.icon}</span>}
        <span
          style={{
            fontSize: 14,
            fontWeight: 500,
            color: 'var(--text-primary)',
          }}
        >
          {spec.title}
        </span>
      </div>
      {plugin.description && (
        <span
          style={{
            fontSize: 12,
            color: 'var(--text-secondary)',
            lineHeight: 1.4,
          }}
        >
          {plugin.description}
        </span>
      )}
      <span
        style={{
          fontSize: 11,
          color: 'var(--text-tertiary)',
          fontFamily: 'var(--font-mono)',
        }}
      >
        {plugin.id}@{plugin.version}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Plugin list row (all installed plugins)
// ---------------------------------------------------------------------------

function PluginListRow({
  plugin,
  hasPage,
  onOpen,
  onOpenHome,
  onOpenSettings,
}: {
  plugin: PluginInfo;
  hasPage: boolean;
  onOpen: () => void;
  onOpenHome: () => void;
  onOpenSettings: () => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '8px 12px',
        borderBottom: '1px solid var(--border-subtle)',
        fontSize: 13,
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{plugin.name}</span>
        <span
          style={{
            fontSize: 11,
            color: 'var(--text-tertiary)',
            fontFamily: 'var(--font-mono)',
          }}
        >
          {plugin.id}@{plugin.version} · {plugin.source}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        {plugin.hasHomePanel && (
          <button type="button" onClick={onOpenHome} style={rowButtonStyle}>
            Home
          </button>
        )}
        <button type="button" onClick={onOpenSettings} style={rowButtonStyle}>
          Settings
        </button>
        {hasPage && (
          <button type="button" onClick={onOpen} style={rowButtonStyle}>
            Open page
          </button>
        )}
      </div>
    </div>
  );
}

const rowButtonStyle: React.CSSProperties = {
  height: 24,
  padding: '0 8px',
  borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--border-subtle)',
  background: 'transparent',
  color: 'var(--text-secondary)',
  fontSize: 11,
  cursor: 'pointer',
};

// ---------------------------------------------------------------------------
// Plugin page view — renders a plugin's page spec sections
// ---------------------------------------------------------------------------

interface PluginPageViewProps {
  pluginId: string;
  spec: PageSpec;
  client: ReturnType<typeof createEthosClient>;
  onBack: () => void;
}

function PluginPageView({ pluginId, spec, client, onBack }: PluginPageViewProps) {
  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        padding: '0 24px',
      }}
    >
      <div
        style={{
          height: 40,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexShrink: 0,
          paddingTop: 8,
        }}
      >
        <button type="button" onClick={onBack} style={backButtonStyle}>
          ←
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {spec.icon && <span style={{ fontSize: 18 }}>{spec.icon}</span>}
          <h3
            style={{
              margin: 0,
              fontSize: 20,
              fontWeight: 600,
              color: 'var(--text-primary)',
            }}
          >
            {spec.title}
          </h3>
        </div>
      </div>

      <div
        style={{
          flex: 1,
          overflow: 'auto',
          paddingTop: 12,
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        {spec.sections.map((section) => (
          <PageSectionRenderer
            key={`${section.type}-${section.label}`}
            pluginId={pluginId}
            section={section}
            client={client}
          />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section renderer — dispatches by section type
// ---------------------------------------------------------------------------

function PageSectionRenderer({
  pluginId,
  section,
  client,
}: {
  pluginId: string;
  section: PageSection;
  client: ReturnType<typeof createEthosClient>;
}) {
  switch (section.type) {
    case 'tool-output':
      return <ToolOutputSection pluginId={pluginId} section={section} client={client} />;
    case 'data-table':
      return <DataTableSection pluginId={pluginId} section={section} client={client} />;
    case 'chart':
      return <ChartSection section={section} />;
    case 'metric':
      return <MetricSection pluginId={pluginId} section={section} client={client} />;
    case 'notification-feed':
      return <NotificationFeedSection section={section} />;
    default:
      return (
        <SectionShell label={section.label}>
          <p style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>
            Unknown section type: {section.type}
          </p>
        </SectionShell>
      );
  }
}

// ---------------------------------------------------------------------------
// Section shell — consistent wrapper
// ---------------------------------------------------------------------------

function SectionShell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        backgroundColor: 'var(--bg-elevated)',
        borderRadius: 'var(--radius-md)',
        border: '1px solid var(--border-subtle)',
        padding: '12px 16px',
      }}
    >
      <SectionLabel>{label}</SectionLabel>
      <div style={{ marginTop: 8 }}>{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hook: invoke a plugin tool, with optional auto-refresh
// ---------------------------------------------------------------------------

function useToolInvocation(
  client: ReturnType<typeof createEthosClient>,
  pluginId: string,
  toolName: string | undefined,
  toolArgs: Record<string, unknown> | undefined,
  autoRefreshMs: number | undefined,
) {
  const [result, setResult] = useState<ToolForPageResult | null>(null);
  const [loading, setLoading] = useState(true);

  const fetch = useCallback(() => {
    if (!toolName) return;
    setLoading(true);
    client.rpc.plugins
      .invokeToolForPage({ pluginId, toolName, args: toolArgs })
      .then((res: ToolForPageResult) => setResult(res))
      .catch((err: unknown) =>
        setResult({
          ok: false,
          value: '',
          error: err instanceof Error ? err.message : String(err),
        }),
      )
      .finally(() => setLoading(false));
  }, [client, pluginId, toolName, toolArgs]);

  useEffect(() => {
    fetch();
    if (autoRefreshMs && autoRefreshMs > 0) {
      const id = setInterval(fetch, autoRefreshMs);
      return () => clearInterval(id);
    }
    return undefined;
  }, [fetch, autoRefreshMs]);

  return { result, loading };
}

// ---------------------------------------------------------------------------
// tool-output section
// ---------------------------------------------------------------------------

function ToolOutputSection({
  pluginId,
  section,
  client,
}: {
  pluginId: string;
  section: PageSection;
  client: ReturnType<typeof createEthosClient>;
}) {
  const { result, loading } = useToolInvocation(
    client,
    pluginId,
    section.toolName,
    section.toolArgs,
    section.autoRefreshMs,
  );

  return (
    <SectionShell label={section.label}>
      {loading && !result ? (
        <p style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>Loading...</p>
      ) : result?.error ? (
        <p style={{ color: 'var(--error)', fontSize: 12 }}>{result.error}</p>
      ) : (
        <pre
          style={{
            margin: 0,
            fontSize: 12,
            fontFamily: 'var(--font-mono)',
            color: 'var(--text-primary)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {result?.value ?? ''}
        </pre>
      )}
    </SectionShell>
  );
}

// ---------------------------------------------------------------------------
// data-table section
// ---------------------------------------------------------------------------

function DataTableSection({
  pluginId,
  section,
  client,
}: {
  pluginId: string;
  section: PageSection;
  client: ReturnType<typeof createEthosClient>;
}) {
  const { result, loading } = useToolInvocation(
    client,
    pluginId,
    section.toolName,
    section.toolArgs,
    section.autoRefreshMs,
  );

  const columns = section.columns ?? [];
  const rows = parseRows(result);

  return (
    <SectionShell label={section.label}>
      {loading && !result ? (
        <p style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>Loading...</p>
      ) : result?.error ? (
        <p style={{ color: 'var(--error)', fontSize: 12 }}>{result.error}</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              fontSize: 12,
              fontFamily: 'var(--font-mono)',
            }}
          >
            <thead>
              <tr>
                {columns.map((col) => (
                  <th
                    key={col}
                    style={{
                      textAlign: 'left',
                      padding: '6px 8px',
                      borderBottom: '1px solid var(--border-subtle)',
                      color: 'var(--text-secondary)',
                      fontWeight: 500,
                    }}
                  >
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={columns.map((c) => String(row[c] ?? '')).join('|')}>
                  {columns.map((col) => (
                    <td
                      key={col}
                      style={{
                        padding: '6px 8px',
                        borderBottom: '1px solid var(--border-subtle)',
                        color: 'var(--text-primary)',
                      }}
                    >
                      {String(row[col] ?? '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && (
            <p style={{ color: 'var(--text-tertiary)', fontSize: 12, marginTop: 8 }}>
              No data returned.
            </p>
          )}
        </div>
      )}
    </SectionShell>
  );
}

function parseRows(result: ToolForPageResult | null): Record<string, unknown>[] {
  if (!result?.structured) return [];
  const data = result.structured;
  if (Array.isArray(data.rows)) return data.rows as Record<string, unknown>[];
  if (Array.isArray(data.data)) return data.data as Record<string, unknown>[];
  return [];
}

// ---------------------------------------------------------------------------
// chart section (placeholder)
// ---------------------------------------------------------------------------

function ChartSection({ section }: { section: PageSection }) {
  return (
    <SectionShell label={section.label}>
      <div
        style={{
          height: 120,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: '1px dashed var(--border-subtle)',
          borderRadius: 'var(--radius-sm)',
          color: 'var(--text-tertiary)',
          fontSize: 12,
        }}
      >
        Chart ({section.chartType ?? 'line'}) — visualization library TBD
      </div>
    </SectionShell>
  );
}

// ---------------------------------------------------------------------------
// metric section
// ---------------------------------------------------------------------------

function MetricSection({
  pluginId,
  section,
  client,
}: {
  pluginId: string;
  section: PageSection;
  client: ReturnType<typeof createEthosClient>;
}) {
  const { result, loading } = useToolInvocation(
    client,
    pluginId,
    section.toolName,
    section.toolArgs,
    section.autoRefreshMs,
  );

  const valueField = section.valueField ?? 'value';
  const raw = result?.structured ? result.structured[valueField] : result?.value;
  const display = raw != null ? String(raw) : '—';

  return (
    <SectionShell label={section.label}>
      {loading && !result ? (
        <p style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>Loading...</p>
      ) : result?.error ? (
        <p style={{ color: 'var(--error)', fontSize: 12 }}>{result.error}</p>
      ) : (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span
            style={{
              fontSize: 28,
              fontWeight: 600,
              fontFamily: 'var(--font-mono)',
              color: 'var(--text-primary)',
            }}
          >
            {display}
          </span>
          {section.unit && (
            <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{section.unit}</span>
          )}
        </div>
      )}
    </SectionShell>
  );
}

// ---------------------------------------------------------------------------
// notification-feed section (placeholder)
// ---------------------------------------------------------------------------

function NotificationFeedSection({ section }: { section: PageSection }) {
  return (
    <SectionShell label={section.label}>
      <div
        style={{
          height: 80,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: '1px dashed var(--border-subtle)',
          borderRadius: 'var(--radius-sm)',
          color: 'var(--text-tertiary)',
          fontSize: 12,
        }}
      >
        Notification feed — no events yet
      </div>
    </SectionShell>
  );
}

// ---------------------------------------------------------------------------
// Shared styles
// ---------------------------------------------------------------------------

const backButtonStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  fontSize: 16,
  color: 'var(--text-secondary)',
  padding: '4px 8px',
  borderRadius: 'var(--radius-sm)',
};
