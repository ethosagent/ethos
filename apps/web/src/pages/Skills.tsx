import { personalityAccent } from '@ethosagent/design-tokens';
import type {
  EvolverRun,
  McpServerInfo,
  PendingSkill,
  PluginInfo,
  Skill,
} from '@ethosagent/web-contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App as AntApp,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Spin,
  Switch,
  Typography,
} from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AddMcpModal } from '../components/mcp/AddMcpModal';
import { McpServerActions } from '../components/mcp/McpServerActions';
import {
  type PluginCredentialSchema,
  PluginSettingsDrawer,
} from '../components/PluginSettingsDrawer';
import { MonoBadge } from '../components/ui/MonoBadge';
import { PersonalityPill } from '../components/ui/PersonalityPill';
import { StatusDot } from '../components/ui/StatusDot';
import { client, rpc } from '../rpc';

// ---------------------------------------------------------------------------
// Unified Skills / MCP / Plugins page
// ---------------------------------------------------------------------------

type OuterTab = 'skills' | 'mcp' | 'plugins';
type InnerTab = 'library' | 'evolver';

export function Skills() {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get('tab');
  const outerTab: OuterTab = rawTab === 'mcp' || rawTab === 'plugins' ? rawTab : 'skills';

  const setOuterTab = useCallback(
    (tab: OuterTab) => {
      if (tab === 'skills') {
        setSearchParams({});
      } else {
        setSearchParams({ tab });
      }
    },
    [setSearchParams],
  );

  return (
    <div className="unified-skills-page">
      {/* Outer tab bar */}
      <div className="unified-tab-bar">
        {(['skills', 'mcp', 'plugins'] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            className={`unified-tab ${outerTab === tab ? 'unified-tab--active' : ''}`}
            onClick={() => setOuterTab(tab)}
          >
            {tab === 'skills' ? 'Skills' : tab === 'mcp' ? 'MCP Servers' : 'Plugins'}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="unified-tab-content">
        {outerTab === 'skills' && <SkillsTabContent />}
        {outerTab === 'mcp' && <McpTabContent />}
        {outerTab === 'plugins' && <PluginsTabContent />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Skills tab — inner tabs: Library | Evolver
// ---------------------------------------------------------------------------

function SkillsTabContent() {
  const [innerTab, setInnerTab] = useState<InnerTab>('library');

  const skillsQuery = useQuery({
    queryKey: ['skills', 'list'],
    queryFn: () => rpc.skills.list(),
  });

  const pendingCount = skillsQuery.data?.pendingCount ?? 0;

  return (
    <div>
      {/* Inner tab bar */}
      <div className="inner-tab-bar">
        <button
          type="button"
          className={`inner-tab ${innerTab === 'library' ? 'inner-tab--active' : ''}`}
          onClick={() => setInnerTab('library')}
        >
          Library
        </button>
        <button
          type="button"
          className={`inner-tab ${innerTab === 'evolver' ? 'inner-tab--active' : ''}`}
          onClick={() => setInnerTab('evolver')}
        >
          Evolver
          {pendingCount > 0 && <span className="inner-tab-badge">{pendingCount}</span>}
        </button>
      </div>

      {innerTab === 'library' && <LibraryPanel skillsQuery={skillsQuery} />}
      {innerTab === 'evolver' && <EvolverPanel />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Library panel
// ---------------------------------------------------------------------------

type SkillOrigin = 'built-in' | 'user' | 'evolver' | 'personality';

function getSkillOrigin(skill: Skill): SkillOrigin {
  if (skill.source === 'system') return 'built-in';
  const scope = skill.frontmatter.scope;
  if (scope === 'evolver') return 'evolver';
  if (scope === 'personality') return 'personality';
  return 'user';
}

interface LibraryPanelProps {
  skillsQuery: ReturnType<typeof useQuery<{ skills: Skill[]; pendingCount: number }>>;
}

function LibraryPanel({ skillsQuery }: LibraryPanelProps) {
  const [editingSkill, setEditingSkill] = useState<Skill | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const skills = skillsQuery.data?.skills ?? [];

  if (skillsQuery.isLoading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 200 }}>
        <Spin />
      </div>
    );
  }
  if (skillsQuery.error) {
    return (
      <Typography.Text type="danger">
        Failed to load skills: {(skillsQuery.error as Error).message}
      </Typography.Text>
    );
  }

  return (
    <>
      {/* Toolbar */}
      <div className="skills-toolbar">
        <span className="skills-count">
          {skills.length} {skills.length === 1 ? 'skill' : 'skills'}
        </span>
        <button type="button" className="skills-add-btn" onClick={() => setCreateOpen(true)}>
          + Add skill
        </button>
      </div>

      {/* Skill rows */}
      {skills.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="No skills installed yet. Create one to teach this agent how you work."
        />
      ) : (
        <div className="skills-list">
          {skills.map((skill) => (
            <SkillRow key={skill.id} skill={skill} onEdit={() => setEditingSkill(skill)} />
          ))}
        </div>
      )}

      {createOpen && <CreateSkillModal open={createOpen} onClose={() => setCreateOpen(false)} />}
      {editingSkill && (
        <EditSkillModal
          key={editingSkill.id}
          skill={editingSkill}
          onClose={() => setEditingSkill(null)}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Skill row
// ---------------------------------------------------------------------------

function SkillRow({ skill, onEdit }: { skill: Skill; onEdit: () => void }) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const [hovered, setHovered] = useState(false);

  const deleteMut = useMutation({
    mutationFn: (id: string) => rpc.skills.delete({ id }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['skills', 'list'] });
      notification.success({ message: `Deleted ${skill.name}`, placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({ message: 'Delete failed', description: (err as Error).message }),
  });

  const origin = getSkillOrigin(skill);
  const initial = skill.name.charAt(0).toUpperCase();

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover-reveal actions
    <div
      className="skill-row"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Icon circle */}
      <div className="skill-row-icon">
        <span>{initial}</span>
      </div>

      {/* Name + description */}
      <div className="skill-row-info">
        <span className="skill-row-name">{skill.name}</span>
        <span className="skill-row-desc">{skill.description ?? 'No description'}</span>
      </div>

      {/* Source */}
      <span className="skill-row-source">
        {origin === 'built-in' ? 'built-in' : `~/.claude/skills/${skill.id}`}
      </span>

      {/* Status badge */}
      <MonoBadge label="enabled" variant="green" />

      {/* Hover actions */}
      <div className="skill-row-actions" style={{ opacity: hovered ? 1 : 0 }}>
        {!skill.readonly && (
          <>
            <button
              type="button"
              className="skill-action-btn"
              title="Edit"
              onClick={(e) => {
                e.stopPropagation();
                onEdit();
              }}
            >
              &#9998;
            </button>
            <Popconfirm
              title="Delete this skill?"
              description="The file is removed from disk."
              onConfirm={() => deleteMut.mutate(skill.id)}
              okText="Delete"
              okButtonProps={{ danger: true }}
            >
              <button
                type="button"
                className="skill-action-btn"
                title="Remove"
                onClick={(e) => e.stopPropagation()}
              >
                &#215;
              </button>
            </Popconfirm>
          </>
        )}
        {skill.readonly && (
          <button
            type="button"
            className="skill-action-btn"
            title="View"
            onClick={(e) => {
              e.stopPropagation();
              onEdit();
            }}
          >
            &#9998;
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Evolver panel
// ---------------------------------------------------------------------------

function EvolverPanel() {
  const [configVisible, setConfigVisible] = useState(false);

  return (
    <div className="evolver-panel">
      <EvolverToolbar onOpenConfig={() => setConfigVisible(true)} />
      <PendingReviewSection />
      <RunHistorySection />
      {configVisible && <EvolverConfigModal onClose={() => setConfigVisible(false)} />}
    </div>
  );
}

function EvolverToolbar({ onOpenConfig }: { onOpenConfig: () => void }) {
  const { data } = useQuery({
    queryKey: ['evolver', 'pending'],
    queryFn: () => rpc.evolver.pendingList(),
  });

  const pendingCount = data?.pending?.length ?? 0;

  return (
    <div className="skills-toolbar">
      <span className="skills-count">{pendingCount} pending review</span>
      <button type="button" className="skills-add-btn" onClick={onOpenConfig}>
        Configure evolver
      </button>
    </div>
  );
}

function PendingReviewSection() {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();

  const { data, isLoading, error } = useQuery({
    queryKey: ['evolver', 'pending'],
    queryFn: () => rpc.evolver.pendingList(),
  });

  const approveMut = useMutation({
    mutationFn: (id: string) => rpc.evolver.pendingApprove({ id }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['evolver', 'pending'] });
      qc.invalidateQueries({ queryKey: ['skills', 'list'] });
      notification.success({ message: 'Approved — skill is now live.', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({ message: 'Approve failed', description: (err as Error).message }),
  });

  const rejectMut = useMutation({
    mutationFn: (id: string) => rpc.evolver.pendingReject({ id }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['evolver', 'pending'] });
      qc.invalidateQueries({ queryKey: ['skills', 'list'] });
      notification.success({ message: 'Rejected', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({ message: 'Reject failed', description: (err as Error).message }),
  });

  if (isLoading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 120 }}>
        <Spin />
      </div>
    );
  }
  if (error) {
    return (
      <Typography.Text type="danger">
        Failed to load queue: {(error as Error).message}
      </Typography.Text>
    );
  }

  const pending = data?.pending ?? [];

  return (
    <div className="evolver-section">
      <div className="evolver-section-label">PENDING REVIEW</div>
      {pending.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginTop: 8 }}>
          No pending candidates. Run the evolver to populate this queue.
        </div>
      ) : (
        <div className="evolver-pending-cards">
          {pending.map((skill) => (
            <PendingSkillCard
              key={skill.id}
              skill={skill}
              onApprove={() => approveMut.mutate(skill.id)}
              onReject={() => rejectMut.mutate(skill.id)}
              approving={approveMut.isPending && approveMut.variables === skill.id}
              rejecting={rejectMut.isPending && rejectMut.variables === skill.id}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function PendingSkillCard({
  skill,
  onApprove,
  onReject,
  approving,
  rejecting,
}: {
  skill: PendingSkill;
  onApprove: () => void;
  onReject: () => void;
  approving: boolean;
  rejecting: boolean;
}) {
  return (
    <div className="pending-skill-card">
      <div className="pending-skill-card-top">
        <span className="pending-skill-card-name">{skill.name}</span>
        <span className="pending-skill-card-desc">{skill.description ?? 'No description'}</span>
      </div>
      <div className="pending-skill-card-actions">
        <button
          type="button"
          className="ghost-btn ghost-btn--blue"
          onClick={onApprove}
          disabled={approving}
        >
          {approving ? 'Approving...' : 'Approve'}
        </button>
        <button
          type="button"
          className="ghost-btn ghost-btn--red"
          onClick={onReject}
          disabled={rejecting}
        >
          {rejecting ? 'Rejecting...' : 'Reject'}
        </button>
      </div>
    </div>
  );
}

function RunHistorySection() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['evolver', 'history'],
    queryFn: () => rpc.evolver.history({ limit: 50 }),
  });

  const runs = useMemo(() => data?.runs ?? [], [data]);

  if (isLoading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 120 }}>
        <Spin />
      </div>
    );
  }
  if (error) {
    return (
      <Typography.Text type="danger">
        Failed to load history: {(error as Error).message}
      </Typography.Text>
    );
  }

  return (
    <div className="evolver-section" style={{ marginTop: 20 }}>
      <div className="evolver-section-label">RUN HISTORY</div>
      {runs.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginTop: 8 }}>
          No evolver runs recorded yet.
        </div>
      ) : (
        <div className="evolver-history-table">
          {runs.map((run, i) => (
            <HistoryRow key={run.ranAt ?? i} run={run} even={i % 2 === 0} />
          ))}
        </div>
      )}
    </div>
  );
}

function HistoryRow({ run, even }: { run: EvolverRun; even: boolean }) {
  const dateStr = new Date(run.ranAt).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  const total = run.rewritesProposed + run.newSkillsProposed;
  const statusVariant = total > 0 ? 'green' : 'dim';

  return (
    <div
      className="history-row"
      style={{ background: even ? 'var(--bg-elevated)' : 'transparent' }}
    >
      <span className="history-row-ts">{dateStr}</span>
      <span className="history-row-detail">
        {run.rewritesProposed} rewrites, {run.newSkillsProposed} new
      </span>
      <MonoBadge label={total > 0 ? 'proposed' : 'no changes'} variant={statusVariant} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// MCP Servers tab content
// ---------------------------------------------------------------------------

function McpTabContent() {
  const [addMcpOpen, setAddMcpOpen] = useState(false);

  const {
    data: pluginsData,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['plugins', 'list'],
    queryFn: () => rpc.plugins.list(),
  });

  if (error) {
    return (
      <Typography.Text type="danger">
        Failed to load MCP servers: {(error as Error).message}
      </Typography.Text>
    );
  }

  const mcpServers = pluginsData?.mcpServers ?? [];

  return (
    <div>
      {/* Info banner */}
      <div className="mcp-info-banner">
        MCP servers extend Ethos with external tools. Configure server URLs and authentication
        tokens in ~/.ethos/config.yaml.
      </div>

      {/* Toolbar */}
      <div className="skills-toolbar">
        <span className="skills-count">
          {mcpServers.length} {mcpServers.length === 1 ? 'server' : 'servers'}
        </span>
        <button type="button" className="skills-add-btn" onClick={() => setAddMcpOpen(true)}>
          + Add server
        </button>
      </div>

      {/* Server rows */}
      {isLoading ? (
        <div style={{ display: 'grid', placeItems: 'center', height: 200 }}>
          <Spin />
        </div>
      ) : mcpServers.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No MCP servers configured." />
      ) : (
        <div className="mcp-server-list">
          {mcpServers.map((server) => (
            <McpServerRow key={server.name} server={server} />
          ))}
        </div>
      )}

      <AddMcpModal open={addMcpOpen} onClose={() => setAddMcpOpen(false)} />
    </div>
  );
}

function getStatusInfo(authStatus: McpServerInfo['auth_status']): {
  dotColor: string;
  label: string;
  variant: 'green' | 'amber' | 'dim';
} {
  switch (authStatus) {
    case 'authorized':
    case 'none':
      return { dotColor: 'var(--green)', label: 'Connected', variant: 'green' };
    case 'missing':
    case 'pending':
      return { dotColor: 'var(--amber)', label: 'Needs auth', variant: 'amber' };
    case 'expired':
      return { dotColor: 'var(--text-tertiary)', label: 'Disconnected', variant: 'dim' };
    default:
      return { dotColor: 'var(--text-tertiary)', label: 'Unknown', variant: 'dim' };
  }
}

function McpServerRow({ server }: { server: McpServerInfo }) {
  const [hovered, setHovered] = useState(false);
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();

  const deleteMut = useMutation({
    mutationFn: (name: string) => rpc.mcp.delete({ name }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['plugins'] });
      qc.invalidateQueries({ queryKey: ['mcp', 'list'] });
    },
    onError: (err) => {
      notification.error({
        message: 'Delete failed',
        description: err instanceof Error ? err.message : String(err),
      });
    },
  });

  const statusInfo = getStatusInfo(server.auth_status);
  const endpoint =
    server.transport === 'stdio'
      ? (server.command ?? 'missing command')
      : (server.url ?? 'missing url');

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover-reveal actions
    <div
      className="mcp-row"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Status dot */}
      <StatusDot color={statusInfo.dotColor} size={8} />

      {/* Name */}
      <span className="mcp-row-name">{server.name}</span>

      {/* Command / URL */}
      <span className="mcp-row-command">{endpoint}</span>

      {/* Status badge */}
      <MonoBadge label={statusInfo.label} variant={statusInfo.variant} />

      {/* Transport badge */}
      <MonoBadge label={server.transport} variant="dim" />

      {/* Actions */}
      <div className="mcp-row-actions" style={{ opacity: hovered ? 1 : 0 }}>
        <McpServerActions
          serverName={server.name}
          transport={server.transport}
          authStatus={server.auth_status}
        />
        <Popconfirm
          title="Remove this server?"
          description="This removes the server definition and any stored tokens."
          okText="Remove"
          okButtonProps={{ danger: true }}
          onConfirm={() => deleteMut.mutate(server.name)}
        >
          <button
            type="button"
            className="skill-action-btn"
            title="Remove"
            onClick={(e) => e.stopPropagation()}
          >
            &#215;
          </button>
        </Popconfirm>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Plugins tab content
// ---------------------------------------------------------------------------

function PluginsTabContent() {
  const { notification } = AntApp.useApp();
  const qc = useQueryClient();
  const [packageSpec, setPackageSpec] = useState('');
  const [settingsPluginId, setSettingsPluginId] = useState<string | null>(null);

  const {
    data: pluginsData,
    isLoading: pluginsLoading,
    error: pluginsError,
  } = useQuery({
    queryKey: ['plugins', 'list'],
    queryFn: () => rpc.plugins.list(),
  });

  const { data: personalitiesData } = useQuery({
    queryKey: ['personalities', 'list'],
    queryFn: () => rpc.personalities.list({}),
  });

  const installMut = useMutation({
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
    <div>
      {/* Header row */}
      <div className="plugins-toolbar">
        <span className="skills-count">
          {plugins.length} {plugins.length === 1 ? 'plugin' : 'plugins'} installed
        </span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            type="text"
            className="plugins-spec-input"
            placeholder="@scope/plugin@1.0.0"
            value={packageSpec}
            onChange={(e) => setPackageSpec(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && packageSpec.trim()) {
                installMut.mutate(packageSpec.trim());
              }
            }}
            disabled={installMut.isPending}
          />
          <button
            type="button"
            className="ghost-btn ghost-btn--blue"
            disabled={!packageSpec.trim() || installMut.isPending}
            onClick={() => installMut.mutate(packageSpec.trim())}
          >
            Install
          </button>
        </div>
      </div>

      {/* Plugin rows */}
      {pluginsLoading ? (
        <div style={{ display: 'grid', placeItems: 'center', height: 200 }}>
          <Spin />
        </div>
      ) : plugins.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No plugins installed." />
      ) : (
        <div className="plugins-list">
          {plugins.map((plugin) => (
            <PluginRow
              key={plugin.id}
              plugin={plugin}
              personalities={personalities}
              onSettingsOpen={() => setSettingsPluginId(plugin.id)}
            />
          ))}
        </div>
      )}

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

function PluginRow({
  plugin,
  personalities,
  onSettingsOpen,
}: {
  plugin: PluginInfo;
  personalities: import('@ethosagent/web-contracts').Personality[];
  onSettingsOpen: () => void;
}) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const [hovered, setHovered] = useState(false);

  const uninstallMut = useMutation({
    mutationFn: (id: string) => rpc.plugins.uninstall({ pluginId: id }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['plugins', 'list'] });
      notification.success({ message: 'Plugin uninstalled' });
    },
    onError: (err) =>
      notification.error({
        message: 'Uninstall failed',
        description: err instanceof Error ? err.message : String(err),
      }),
  });

  const usedBy = personalities.filter((p) => (p.plugins ?? []).includes(plugin.id));

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover-reveal actions
    <div
      className="plugin-row"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Name + version */}
      <div className="plugin-row-info">
        <div className="plugin-row-name-line">
          <span className="plugin-row-name">{plugin.name}</span>
          <span className="plugin-row-version">v{plugin.version}</span>
        </div>
        {plugin.description && <span className="plugin-row-desc">{plugin.description}</span>}
      </div>

      {/* Source */}
      <span className="plugin-row-source">{plugin.id}</span>

      {/* Used by pills */}
      <div className="plugin-row-pills">
        {usedBy.length > 0 ? (
          usedBy.map((p) => (
            <PersonalityPill key={p.id} name={p.name} color={personalityAccent(p.id)} />
          ))
        ) : (
          <span className="plugin-row-warning">
            <span className="plugin-row-warning-icon">&#9888;</span>
            Not used by any personality
          </span>
        )}
      </div>

      {/* Actions */}
      <div className="plugin-row-actions" style={{ opacity: hovered ? 1 : 0 }}>
        <button
          type="button"
          className="skill-action-btn"
          title="Settings"
          onClick={(e) => {
            e.stopPropagation();
            onSettingsOpen();
          }}
        >
          &#9881;
        </button>
        <Popconfirm
          title="Uninstall this plugin?"
          description="The package is removed."
          onConfirm={() => uninstallMut.mutate(plugin.id)}
          okText="Uninstall"
          okButtonProps={{ danger: true }}
        >
          <button
            type="button"
            className="skill-action-btn"
            title="Uninstall"
            onClick={(e) => e.stopPropagation()}
          >
            &#215;
          </button>
        </Popconfirm>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Evolver config modal (reusing existing form logic)
// ---------------------------------------------------------------------------

function EvolverConfigModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const [form] = Form.useForm();

  const { data, isLoading, error } = useQuery({
    queryKey: ['evolver', 'config'],
    queryFn: () => rpc.evolver.configGet(),
  });

  useEffect(() => {
    if (data?.config) form.setFieldsValue(data.config);
  }, [data, form]);

  const updateMut = useMutation({
    mutationFn: (cfg: Parameters<typeof rpc.evolver.configUpdate>[0]) =>
      rpc.evolver.configUpdate(cfg),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['evolver', 'config'] });
      notification.success({ message: 'Saved', placement: 'topRight' });
      onClose();
    },
    onError: (err) =>
      notification.error({ message: 'Save failed', description: (err as Error).message }),
  });

  return (
    <Modal
      open
      title="Evolver Configuration"
      onCancel={onClose}
      onOk={() => form.submit()}
      okText="Save"
      okButtonProps={{ loading: updateMut.isPending }}
      destroyOnClose
      width={520}
    >
      {isLoading ? (
        <div style={{ display: 'grid', placeItems: 'center', height: 200 }}>
          <Spin />
        </div>
      ) : error ? (
        <Typography.Text type="danger">
          Failed to load config: {(error as Error).message}
        </Typography.Text>
      ) : (
        <Form form={form} layout="vertical" onFinish={(values) => updateMut.mutate(values)}>
          <Form.Item
            label="Rewrite threshold"
            name="rewriteThreshold"
            extra="Skills with avg score below this are rewrite candidates. 0-1."
          >
            <InputNumber min={0} max={1} step={0.05} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item
            label="New-skill pattern threshold"
            name="newSkillPatternThreshold"
            extra="Tasks scoring above this with no skill assistance can seed a new skill. 0-1."
          >
            <InputNumber min={0} max={1} step={0.05} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item label="Min runs before evolving" name="minRunsBeforeEvolve">
            <InputNumber min={0} step={1} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item label="Min pattern count for new skills" name="minPatternCount">
            <InputNumber min={0} step={1} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item label="Auto-approve evolved skills" name="autoApprove" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Create / Edit skill modals (preserved from original)
// ---------------------------------------------------------------------------

function CreateSkillModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const [form] = Form.useForm<{ id: string; body: string }>();

  const createMut = useMutation({
    mutationFn: (input: { id: string; body: string }) => rpc.skills.create(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['skills', 'list'] });
      notification.success({ message: 'Skill created', placement: 'topRight' });
      onClose();
    },
    onError: (err) =>
      notification.error({ message: 'Create failed', description: (err as Error).message }),
  });

  return (
    <Modal
      open={open}
      title="New skill"
      onCancel={onClose}
      onOk={() => form.submit()}
      okText="Create"
      okButtonProps={{ loading: createMut.isPending }}
      destroyOnClose
      width={680}
    >
      <Form
        form={form}
        layout="vertical"
        onFinish={(values) => createMut.mutate(values)}
        initialValues={{
          body: '---\nname: my-skill\ndescription: One-line summary\n---\n\nWrite the skill body here.\n',
        }}
      >
        <Form.Item
          label="ID"
          name="id"
          rules={[
            { required: true, message: 'Required' },
            {
              pattern: /^[a-zA-Z0-9_-]+$/,
              message: 'Letters, digits, dash, underscore only.',
            },
          ]}
          extra="Becomes the filename. Cannot be changed later."
        >
          <Input autoFocus placeholder="e.g. summarize-pr" />
        </Form.Item>
        <Form.Item label="Body" name="body" rules={[{ required: true, message: 'Required' }]}>
          <Input.TextArea rows={14} style={{ fontFamily: 'var(--font-mono)' }} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function EditSkillModal({ skill, onClose }: { skill: Skill; onClose: () => void }) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const [form] = Form.useForm<{ body: string }>();
  const isReadonly = skill.readonly;

  const { data, isLoading } = useQuery({
    queryKey: ['skills', 'get', skill.id],
    queryFn: () => rpc.skills.get({ id: skill.id }),
  });

  useEffect(() => {
    if (data?.skill) {
      form.setFieldsValue({ body: rebuildBody(data.skill) });
    }
  }, [data, form]);

  const updateMut = useMutation({
    mutationFn: (body: string) => rpc.skills.update({ id: skill.id, body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['skills', 'list'] });
      notification.success({ message: 'Saved', placement: 'topRight' });
      onClose();
    },
    onError: (err) =>
      notification.error({ message: 'Save failed', description: (err as Error).message }),
  });

  return (
    <Modal
      open
      title={isReadonly ? `View ${skill.name}` : `Edit ${skill.name}`}
      onCancel={onClose}
      onOk={isReadonly ? onClose : () => form.submit()}
      okText={isReadonly ? 'Close' : 'Save'}
      okButtonProps={isReadonly ? {} : { loading: updateMut.isPending }}
      cancelButtonProps={isReadonly ? { style: { display: 'none' } } : {}}
      destroyOnClose
      width={680}
    >
      {isLoading ? (
        <div style={{ display: 'grid', placeItems: 'center', height: 200 }}>
          <Spin />
        </div>
      ) : (
        <Form form={form} layout="vertical" onFinish={(values) => updateMut.mutate(values.body)}>
          <Form.Item
            label="Body"
            name="body"
            rules={isReadonly ? [] : [{ required: true, message: 'Required' }]}
          >
            <Input.TextArea
              rows={18}
              style={{ fontFamily: 'var(--font-mono)' }}
              disabled={isReadonly}
            />
          </Form.Item>
        </Form>
      )}
    </Modal>
  );
}

function rebuildBody(skill: Skill): string {
  const fmKeys = Object.keys(skill.frontmatter);
  if (fmKeys.length === 0) return skill.body;
  const lines = fmKeys.map((k) => `${k}: ${stringifyFrontmatterValue(skill.frontmatter[k])}`);
  return `---\n${lines.join('\n')}\n---\n\n${skill.body}`;
}

function stringifyFrontmatterValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}
