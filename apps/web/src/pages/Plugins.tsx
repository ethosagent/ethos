import type { PluginInfo } from '@ethosagent/web-contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App as AntApp,
  Button,
  Checkbox,
  Collapse,
  Empty,
  Input,
  Skeleton,
  Table,
  Typography,
} from 'antd';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  type PluginCredentialSchema,
  PluginSettingsDrawer,
} from '../components/PluginSettingsDrawer';
import { client, rpc } from '../rpc';

function InstallPluginSection() {
  const { notification } = AntApp.useApp();
  const qc = useQueryClient();
  const [packageSpec, setPackageSpec] = useState('');

  const mut = useMutation({
    mutationFn: (spec: string) => rpc.plugins.install({ packageSpec: spec }),
    onSuccess: () => {
      notification.success({ message: 'Plugin installed' });
      setPackageSpec('');
      qc.invalidateQueries({ queryKey: ['plugins', 'list'] });
    },
    onError: (err) => {
      notification.error({
        message: 'Install failed',
        description: err instanceof Error ? err.message : String(err),
      });
    },
  });

  return (
    <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
      <Input
        placeholder="Package spec, e.g. @scope/my-plugin@1.0.0"
        value={packageSpec}
        onChange={(e) => setPackageSpec(e.target.value)}
        onPressEnter={() => packageSpec.trim() && mut.mutate(packageSpec.trim())}
        disabled={mut.isPending}
        style={{ flex: 1 }}
      />
      <Button
        type="primary"
        loading={mut.isPending}
        disabled={!packageSpec.trim()}
        onClick={() => mut.mutate(packageSpec.trim())}
      >
        Install
      </Button>
    </div>
  );
}

// Plugins page — global matrix of plugins × personalities.
//
// Antd Table, rows = plugins, cols = personalities.
// Below 900px: pivots to per-plugin Collapse accordion.
//
// Attachment toggles call personalities.update({ plugins: [...] })
// optimistically per-personality per-plugin. Rollback on error.

export function Plugins() {
  const {
    data: pluginsData,
    isLoading: pluginsLoading,
    error: pluginsError,
  } = useQuery({
    queryKey: ['plugins', 'list'],
    queryFn: () => rpc.plugins.list(),
  });

  const { data: personalitiesData, isLoading: persLoading } = useQuery({
    queryKey: ['personalities', 'list'],
    queryFn: () => rpc.personalities.list({}),
  });

  const isLoading = pluginsLoading || persLoading;
  const [installOpen, setInstallOpen] = useState(false);
  const [settingsPluginId, setSettingsPluginId] = useState<string | null>(null);

  const settingsPlugin = settingsPluginId
    ? ((pluginsData?.plugins ?? []).find((p) => p.id === settingsPluginId) ?? null)
    : null;

  const { data: credKeysData } = useQuery({
    queryKey: ['plugins', 'credentialKeys', settingsPluginId],
    queryFn: () => {
      const id = settingsPluginId;
      if (!id) return { keys: [] };
      return rpc.plugins.listCredentialKeys({ pluginId: id });
    },
    enabled: Boolean(settingsPluginId),
  });

  const credentials = useMemo((): PluginCredentialSchema[] => {
    if (!settingsPluginId) return [];
    // Zerodha: hardcoded because the access token uses kind:'oauth' which
    // listCredentialKeys doesn't surface (it only knows 'secret'/'text').
    if (settingsPluginId === 'tools-india-broker-zerodha') {
      return [
        { ref: 'brokers/zerodha/apiKey', label: 'API Key', kind: 'secret' },
        { ref: 'brokers/zerodha/apiSecret', label: 'API Secret', kind: 'secret' },
        {
          ref: 'brokers/zerodha/accessToken',
          label: 'Access Token',
          kind: 'oauth',
          oauthRef: 'zerodha',
        },
      ];
    }
    return (credKeysData?.keys ?? []).map((k) => ({
      ref: k.key,
      label: k.label,
      kind: k.type as 'text' | 'secret',
      description: k.description ?? undefined,
    }));
  }, [settingsPluginId, credKeysData]);

  if (pluginsError) {
    return (
      <Typography.Text type="danger">
        Failed to load plugins: {(pluginsError as Error).message}
      </Typography.Text>
    );
  }

  const plugins = pluginsData?.plugins ?? [];
  const personalities = personalitiesData?.items ?? [];

  return (
    <div className="plugins-tab">
      <header className="page-header-row">
        <h1 className="page-h1">Plugins</h1>
        <span className="page-subtitle">{plugins.length} {plugins.length === 1 ? 'plugin' : 'plugins'}</span>
        <div style={{ flex: 1 }} />
        <button className="page-action-btn" onClick={() => setInstallOpen((o) => !o)}>
          + New Plugin
        </button>
      </header>
      {installOpen && <InstallPluginSection />}
      <PluginsMatrix
        plugins={plugins}
        personalities={personalities}
        loading={isLoading}
        onSettingsOpen={setSettingsPluginId}
      />
      {settingsPlugin && (
        <PluginSettingsDrawer
          pluginId={settingsPlugin.id}
          name={settingsPlugin.name}
          version={settingsPlugin.version}
          description={settingsPlugin.description ?? undefined}
          credentials={credentials}
          tools={[]}
          theme="dark"
          client={client}
          onClose={() => setSettingsPluginId(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Matrix — plugins × personalities. Responsive: table above 900px,
// per-plugin accordion below 900px.
// ---------------------------------------------------------------------------

function PluginsMatrix({
  plugins,
  personalities,
  loading,
  onSettingsOpen,
}: {
  plugins: PluginInfo[];
  personalities: import('@ethosagent/web-contracts').Personality[];
  loading: boolean;
  onSettingsOpen: (pluginId: string) => void;
}) {
  const [narrow, setNarrow] = useState(() => window.innerWidth < 900);

  // Detect viewport width changes.
  if (typeof window !== 'undefined') {
    const mq = window.matchMedia('(max-width: 899px)');
    mq.onchange = (e) => setNarrow(e.matches);
  }

  if (loading) {
    return <Skeleton active paragraph={{ rows: 5 }} />;
  }

  if (plugins.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={
          <span>
            No plugins installed.{' '}
            <Typography.Text code>ethos plugin install &lt;path&gt;</Typography.Text> drops one into
            ~/.ethos/plugins/.
          </span>
        }
      />
    );
  }

  // Unattached: plugins with zero personality attachments anywhere.
  const unattached = plugins.filter((p) =>
    personalities.every((pers) => !(pers.plugins ?? []).includes(p.id)),
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {unattached.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          message={`${unattached.length} ${unattached.length === 1 ? 'plugin is' : 'plugins are'} installed but not attached to any personality — they're inert until attached.`}
          closable
        />
      ) : null}
      {narrow ? (
        <PluginsAccordion
          plugins={plugins}
          personalities={personalities}
          onSettingsOpen={onSettingsOpen}
        />
      ) : (
        <PluginsTable
          plugins={plugins}
          personalities={personalities}
          onSettingsOpen={onSettingsOpen}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Full matrix table (≥900px)
// ---------------------------------------------------------------------------

function PluginsTable({
  plugins,
  personalities,
  onSettingsOpen,
}: {
  plugins: PluginInfo[];
  personalities: import('@ethosagent/web-contracts').Personality[];
  onSettingsOpen: (pluginId: string) => void;
}) {
  const navigate = useNavigate();
  const personalityCols = personalities.map((pers) => ({
    title: <span style={{ fontSize: 12 }}>{pers.name}</span>,
    key: pers.id,
    width: 120,
    align: 'center' as const,
    render: (_: unknown, plugin: PluginInfo) => <AttachCell plugin={plugin} personality={pers} />,
  }));

  return (
    <Table<PluginInfo>
      aria-label="Plugin attachment matrix"
      rowKey="id"
      dataSource={plugins}
      pagination={false}
      size="small"
      columns={[
        {
          title: 'Plugin',
          key: 'plugin',
          render: (_, p) => (
            <div>
              <div style={{ fontWeight: 500 }}>
                {p.name}
                <Typography.Text
                  type="secondary"
                  style={{ fontSize: 11, marginLeft: 6, fontWeight: 400 }}
                >
                  v{p.version}
                </Typography.Text>
              </div>
              <Typography.Text
                style={{ fontFamily: 'Geist Mono, monospace', fontSize: 12 }}
                type="secondary"
              >
                {p.id}
              </Typography.Text>
            </div>
          ),
        },
        ...personalityCols,
        {
          title: '',
          key: 'page',
          width: 100,
          render: (_: unknown, p: PluginInfo) =>
            p.pluginContractMajor != null && p.pluginContractMajor >= 2 ? (
              <Button
                size="small"
                type="link"
                onClick={() => navigate(`/plugins/${encodeURIComponent(p.id)}`)}
              >
                View Page
              </Button>
            ) : null,
        },
        {
          title: '',
          key: 'settings',
          width: 80,
          render: (_: unknown, p: PluginInfo) => (
            <Button size="small" onClick={() => onSettingsOpen(p.id)}>
              Settings
            </Button>
          ),
        },
      ]}
    />
  );
}

// ---------------------------------------------------------------------------
// Per-plugin accordion (< 900px)
// ---------------------------------------------------------------------------

function PluginsAccordion({
  plugins,
  personalities,
  onSettingsOpen,
}: {
  plugins: PluginInfo[];
  personalities: import('@ethosagent/web-contracts').Personality[];
  onSettingsOpen: (pluginId: string) => void;
}) {
  const navigate = useNavigate();
  return (
    <Collapse
      accordion={false}
      items={plugins.map((plugin) => ({
        key: plugin.id,
        label: (
          <span>
            <span style={{ fontWeight: 500 }}>{plugin.name}</span>{' '}
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              v{plugin.version}
            </Typography.Text>{' '}
            <Typography.Text
              style={{ fontFamily: 'Geist Mono, monospace', fontSize: 12 }}
              type="secondary"
            >
              {plugin.id}
            </Typography.Text>
          </span>
        ),
        children: (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {personalities.map((pers) => (
              <div key={pers.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <AttachCell plugin={plugin} personality={pers} />
                <span>{pers.name}</span>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
              {plugin.pluginContractMajor != null && plugin.pluginContractMajor >= 2 ? (
                <Button
                  size="small"
                  type="link"
                  style={{ alignSelf: 'flex-start' }}
                  onClick={() => navigate(`/plugins/${encodeURIComponent(plugin.id)}`)}
                >
                  View Page
                </Button>
              ) : null}
              <Button size="small" onClick={() => onSettingsOpen(plugin.id)}>
                Settings
              </Button>
            </div>
          </div>
        ),
      }))}
    />
  );
}

// ---------------------------------------------------------------------------
// Single attach cell — optimistic Switch/Checkbox toggle
// ---------------------------------------------------------------------------

function AttachCell({
  plugin,
  personality,
}: {
  plugin: PluginInfo;
  personality: import('@ethosagent/web-contracts').Personality;
}) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const current = personality.plugins ?? [];
  const isOn = current.includes(plugin.id);

  const mut = useMutation({
    mutationFn: (next: string[]) => rpc.personalities.update({ id: personality.id, plugins: next }),
    onMutate: async (next) => {
      await qc.cancelQueries({ queryKey: ['personalities', 'list'] });
      const prev = qc.getQueryData<{
        items: import('@ethosagent/web-contracts').Personality[];
      }>(['personalities', 'list']);
      qc.setQueryData<{
        items: import('@ethosagent/web-contracts').Personality[];
        nextCursor: string | null;
        defaultId: string;
      }>(['personalities', 'list'], (old) => {
        if (!old) return old;
        return {
          ...old,
          items: old.items.map((p) => (p.id === personality.id ? { ...p, plugins: next } : p)),
        };
      });
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(['personalities', 'list'], ctx.prev);
      notification.error({
        message: 'Attach failed',
        description: `Could not update ${personality.name}`,
      });
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['personalities', 'list'] });
    },
  });

  function toggle(on: boolean) {
    const next = on ? [...current, plugin.id] : current.filter((id) => id !== plugin.id);
    mut.mutate(next);
  }

  return (
    <Checkbox
      checked={isOn}
      disabled={mut.isPending}
      onChange={(e) => toggle(e.target.checked)}
      aria-label={`Attach ${plugin.name} to ${personality.name}`}
    />
  );
}
