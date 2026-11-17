import type { Personality } from '@ethosagent/web-contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MenuProps } from 'antd';
import { App as AntApp, Divider, Dropdown, Empty, Spin, Table, Tag, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PersonalityName } from '../components/ui/PersonalityName';
import { PersonalityRingAvatar } from '../components/ui/PersonalityRingAvatar';
import { TeamRing } from '../components/ui/TeamRing';
import { useTeamMembership } from '../features/teams/api/queries';
import { teamAccents } from '../features/teams/lib/membership';
import { useCreateFlag } from '../hooks/useCreateFlag';
import { buildTeamPath } from '../lib/workspaceRoutes';
import { rpc } from '../rpc';
import { CreateWizard } from './personalities/CreateWizard';
import { DuplicateModal, EditModal } from './personalities/EditModal';

export { ConfigEditor } from './personalities/ConfigEditor';
export { slugify } from './personalities/CreateWizard';
export type { EditModalTabKey } from './personalities/EditModal';
export { DuplicateModal, EditModal } from './personalities/EditModal';
export { IdentityEditor } from './personalities/IdentityEditor';
export { WizardPluginsTab } from './personalities/PluginsPanels';
export type { ServerToolState } from './personalities/ServerToolChecklist';
export { initialSelectionFor, ServerToolChecklist } from './personalities/ServerToolChecklist';
export { SkillsPicker } from './personalities/SkillsPanels';
export { ToolsetPicker } from './personalities/ToolsetPickers';

// Personalities tab — v1.
//
// List of all personalities (built-in + user-created) with three
// row-level actions:
//   • Edit       — opens a 3-tab modal (Identity / Toolset / Config).
//                  Skills sub-surface lives there too. Built-ins are
//                  read-only here; the action becomes "Duplicate."
//   • Duplicate  — copies the personality into ~/.ethos/personalities/
//                  under a new id, opens the editor on the copy.
//   • Delete     — only for user-created personalities.
//
// Plus a "New personality" button at the top → tabbed create wizard.
//
// Live preview chat (plan: side-pane disposable session) is deferred
// to v1.x — the chat plumbing has assumptions about persistent
// session state that need a wider refactor to disposable mode.

export function Personalities() {
  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [duplicatePrompt, setDuplicatePrompt] = useState<Personality | null>(null);

  // P5 — StageHeader's "+ New Personality" action navigates here with
  // `?create=1`; this opens the same create wizard the page's own button
  // does.
  const shouldCreate = useCreateFlag();
  useEffect(() => {
    if (shouldCreate) setCreateOpen(true);
  }, [shouldCreate]);

  const listQuery = useQuery({
    queryKey: ['personalities', 'list'],
    queryFn: () => rpc.personalities.list({}),
  });
  // teams-as-a-scope T1 (§10, D3): a personality in a team is listed under
  // "In a team" — dimmed, with the team's ring — and opens the team's scope;
  // only the independent ones keep the full row. Derived from `teams.list`,
  // never stored on the personality.
  const membership = useTeamMembership();

  if (listQuery.isLoading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 200 }}>
        <Spin />
      </div>
    );
  }
  if (listQuery.error) {
    return (
      <Typography.Text type="danger">
        Failed to load personalities: {(listQuery.error as Error).message}
      </Typography.Text>
    );
  }

  const personalities = listQuery.data?.items ?? [];
  const defaultId = listQuery.data?.defaultId ?? null;
  const userPersonalities = personalities.filter((p) => !p.system);
  const systemPersonalities = personalities.filter((p) => p.system);
  const inTeam = userPersonalities.filter((p) => membership.byPersonality.has(p.id));
  const independent = userPersonalities.filter((p) => !membership.byPersonality.has(p.id));

  const columns = [
    {
      title: '',
      key: 'avatar',
      width: 48,
      render: (_: unknown, p: Personality) => (
        <PersonalityRingAvatar personalityId={p.id} size={32} avatarUrl={p.display?.avatar_url} />
      ),
    },
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
      render: (name: string, p: Personality) => (
        <div>
          <div style={{ fontWeight: 500 }}>
            <Link
              to={`/personalities/${p.id}`}
              style={{ fontWeight: 500, color: 'var(--text-primary)' }}
            >
              <PersonalityName name={name} emoji={p.display?.emoji} />
            </Link>{' '}
            {p.id === defaultId ? <Tag color="blue">default</Tag> : null}{' '}
            {p.builtin ? <Tag>built-in</Tag> : null}
          </div>
          <div style={{ color: 'var(--ethos-text-dim)', fontSize: 11 }}>{p.id}</div>
        </div>
      ),
    },
    {
      title: 'Description',
      dataIndex: 'description',
      key: 'description',
      render: (d: string | null) =>
        d ? (
          <span
            style={{
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              fontSize: 12,
              color: 'var(--ethos-text-dim)',
              lineHeight: 1.5,
            }}
          >
            {d}
          </span>
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
    {
      title: 'Model',
      dataIndex: 'model',
      key: 'model',
      width: 140,
      render: (m: string | { trivial?: string; default?: string; deep?: string } | null) =>
        m ? (
          <span
            style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--ethos-text-dim)' }}
          >
            {typeof m === 'string' ? m : (m.default ?? m.trivial ?? m.deep ?? '—')}
          </span>
        ) : (
          <span style={{ color: 'var(--ethos-text-dim)' }}>—</span>
        ),
    },
    {
      title: 'Tools',
      dataIndex: 'toolset',
      key: 'toolset',
      width: 60,
      align: 'right' as const,
      render: (t: string[] | null) => (
        <span
          style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--ethos-text-dim)' }}
        >
          {t?.length ?? 0}
        </span>
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 48,
      render: (_: unknown, p: Personality) => (
        <PersonalityRowActions
          personality={p}
          onEdit={() => navigate(`/personalities/${p.id}`)}
          onDuplicate={() => setDuplicatePrompt(p)}
        />
      ),
    },
  ];

  return (
    <div className="personalities-tab">
      <header className="page-header-row">
        <h1 className="page-h1">Personalities</h1>
        <span className="page-subtitle">
          {userPersonalities.length}{' '}
          {userPersonalities.length === 1 ? 'personality' : 'personalities'}
        </span>
        <div style={{ flex: 1 }} />
        <button type="button" className="page-action-btn" onClick={() => setCreateOpen(true)}>
          + New Personality
        </button>
      </header>

      {membership.teams.length > 0 ? (
        <div className="personalities-group-label">
          Independent
          <span className="personalities-group-sub">
            {' '}
            · {independent.length} {independent.length === 1 ? 'personality' : 'personalities'} in
            no team
          </span>
        </div>
      ) : null}
      <Table<Personality>
        rowKey="id"
        dataSource={independent}
        pagination={false}
        size="small"
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="No personalities loaded. Run `ethos setup` first."
            />
          ),
        }}
        columns={columns}
      />

      {inTeam.length > 0 ? (
        <>
          <div className="personalities-group-label">
            In a team
            <span className="personalities-group-sub">
              {' '}
              · shown under their team's scope, not here
            </span>
          </div>
          <Table<Personality>
            rowKey="id"
            dataSource={inTeam}
            pagination={false}
            size="small"
            showHeader={false}
            rowClassName={() => 'personalities-row-in-team'}
            columns={[
              ...columns.slice(0, 2),
              {
                title: 'Team',
                key: 'team',
                render: (_: unknown, p: Personality) => (
                  <span className="personalities-team-chips">
                    {(membership.byPersonality.get(p.id) ?? []).map((team) => (
                      <button
                        key={team.name}
                        type="button"
                        className="personalities-team-chip"
                        onClick={() => navigate(buildTeamPath(team.name))}
                      >
                        <TeamRing accents={teamAccents(team)} size={12} title={team.name} />
                        {team.name}
                        {team.coordinator === p.id ? ' · coordinator' : ''}
                      </button>
                    ))}
                  </span>
                ),
              },
              {
                title: '',
                key: 'open',
                width: 120,
                align: 'right' as const,
                render: (_: unknown, p: Personality) => {
                  const first = membership.byPersonality.get(p.id)?.[0];
                  return first ? (
                    <button
                      type="button"
                      className="personalities-open-team"
                      onClick={() => navigate(buildTeamPath(first.name))}
                    >
                      open team →
                    </button>
                  ) : null;
                },
              },
            ]}
          />
        </>
      ) : null}

      {systemPersonalities.length > 0 ? (
        <>
          <Divider titlePlacement="left">System</Divider>
          <Table<Personality>
            rowKey="id"
            dataSource={systemPersonalities}
            pagination={false}
            size="small"
            columns={columns}
          />
        </>
      ) : null}

      {createOpen ? (
        <CreateWizard
          existingIds={new Set(personalities.map((p) => p.id))}
          onClose={() => setCreateOpen(false)}
        />
      ) : null}
      {editingId ? (
        <EditModal key={editingId} id={editingId} onClose={() => setEditingId(null)} />
      ) : null}
      {duplicatePrompt ? (
        <DuplicateModal
          source={duplicatePrompt}
          existingIds={new Set(personalities.map((p) => p.id))}
          onClose={() => setDuplicatePrompt(null)}
          onDone={(newId) => {
            setDuplicatePrompt(null);
            setEditingId(newId);
          }}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row actions
// ---------------------------------------------------------------------------

function PersonalityRowActions({
  personality,
  onEdit,
  onDuplicate,
}: {
  personality: Personality;
  onEdit: () => void;
  onDuplicate: () => void;
}) {
  const qc = useQueryClient();
  const { notification, modal } = AntApp.useApp();
  const deleteMut = useMutation({
    mutationFn: (id: string) => rpc.personalities.delete({ id }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['personalities', 'list'] });
      qc.invalidateQueries({ queryKey: ['palette', 'personalities'] });
      notification.success({ message: `Deleted ${personality.name}`, placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({ message: 'Delete failed', description: (err as Error).message }),
  });

  const items: MenuProps['items'] = [
    { key: 'edit', label: '✎ Edit' },
    { key: 'duplicate', label: '⧉ Duplicate' },
    ...(personality.builtin
      ? []
      : [{ type: 'divider' as const }, { key: 'delete', label: '🗑 Delete', danger: true }]),
  ];

  return (
    <Dropdown
      menu={{
        items,
        onClick: ({ key, domEvent }) => {
          domEvent.stopPropagation();
          if (key === 'edit') onEdit();
          else if (key === 'duplicate') onDuplicate();
          else if (key === 'delete') {
            modal.confirm({
              title: `Delete ${personality.name}?`,
              content: 'The directory under ~/.ethos/personalities/ is removed.',
              okText: 'Delete',
              okButtonProps: { danger: true },
              onOk: () => deleteMut.mutate(personality.id),
            });
          }
        },
      }}
      trigger={['click']}
      placement="bottomRight"
    >
      <button
        type="button"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'none',
          border: 'none',
          color: 'var(--ethos-text-dim)',
          cursor: 'pointer',
          padding: '2px 6px',
          borderRadius: 4,
          fontSize: 16,
          lineHeight: 1,
        }}
      >
        ⋯
      </button>
    </Dropdown>
  );
}
