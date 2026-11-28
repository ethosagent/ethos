import type { SkillVersion, SkillVersionSource } from '@ethosagent/web-contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Button, Drawer, Popconfirm, Spin, Switch, Typography } from 'antd';
import { useMemo, useState } from 'react';
import { personalityKeys } from '../../features/personalities/api/keys';
import { unifiedDiff } from '../../lib/learning';
import { rpc } from '../../rpc';

// The Skills page's version history and lock (plan skill-history-and-lock, D2).
// Every control here is a thin shell over `skills.history / version / restore /
// setLock`; the lock itself is enforced server-side by
// `SkillHistory.writeAgentAuthored` (extensions/skills/src/skill-history.ts), so
// nothing in this file decides who may write a skill.

/** Reader-facing words for how a version came to be (`SKILL_VERSION_SOURCES`). */
export const SOURCE_LABELS: Record<SkillVersionSource, string> = {
  learning: 'Learned',
  'learning-rollback': 'Rolled back',
  'web-edit': 'Edited here',
  'web-import': 'Imported',
  restore: 'Restored',
  external: 'Edited outside Ethos',
};

function scopeKey(personalityId: string | undefined): string | null {
  return personalityId ?? null;
}

function refreshSkillLists(
  qc: ReturnType<typeof useQueryClient>,
  personalityId: string | undefined,
): void {
  qc.invalidateQueries({ queryKey: ['skills', 'list'] });
  qc.invalidateQueries({ queryKey: ['skills', 'get'] });
  if (personalityId) qc.invalidateQueries({ queryKey: personalityKeys.skills(personalityId) });
}

export function LockGlyph() {
  return (
    <svg
      aria-hidden="true"
      width={12}
      height={12}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3.5 7.5h9v6.5h-9zM5.5 7.5V5a2.5 2.5 0 0 1 5 0v2.5" />
    </svg>
  );
}

/** A small "Locked" chip for a card header or meta row. */
export function LockedChip() {
  return (
    <span className="learning-chip" data-testid="skill-locked-chip" title="Agents cannot change it">
      <LockGlyph /> Locked
    </span>
  );
}

export function SkillLockSwitch({
  skillId,
  locked,
  personalityId,
}: {
  skillId: string;
  locked: boolean;
  personalityId?: string | undefined;
}) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const mut = useMutation({
    mutationFn: (next: boolean) =>
      rpc.skills.setLock({
        id: skillId,
        locked: next,
        ...(personalityId ? { personalityId } : {}),
      }),
    onSuccess: () => refreshSkillLists(qc, personalityId),
    onError: (err) =>
      notification.error({ message: 'Lock change failed', description: (err as Error).message }),
  });
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <Switch
        size="small"
        checked={locked}
        loading={mut.isPending}
        aria-label={locked ? 'Unlock skill' : 'Lock skill'}
        onChange={(next) => mut.mutate(next)}
      />
      <span style={{ fontSize: 12 }}>{locked ? 'Locked' : 'Lock'}</span>
    </span>
  );
}

/** The bytes of one version, fetched once and cached by version id. */
function useVersionBytes(
  skillId: string,
  personalityId: string | undefined,
  versionId: string | undefined,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ['skills', 'version', scopeKey(personalityId), skillId, versionId ?? null],
    queryFn: () =>
      rpc.skills.version({
        id: skillId,
        ...(personalityId ? { personalityId } : {}),
        versionId: versionId ?? '',
      }),
    enabled: enabled && versionId !== undefined,
  });
}

/** The "History (n)" button and its drawer, for one skill card. */
export function SkillHistoryButton({
  skillId,
  skillName,
  personalityId,
  versionCount,
}: {
  skillId: string;
  skillName: string;
  personalityId?: string | undefined;
  versionCount: number;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="small" data-testid="skill-history-open" onClick={() => setOpen(true)}>
        History ({versionCount})
      </Button>
      {open ? (
        <SkillHistoryDrawer
          skillId={skillId}
          skillName={skillName}
          personalityId={personalityId}
          open={open}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function detailOf(v: SkillVersion): string {
  if (v.source === 'restore' && v.restoredFrom) return `back to ${v.restoredFrom}`;
  if (v.candidateId) return `candidate ${v.candidateId}`;
  if (v.hash === null) return 'file removed';
  return v.note ?? '';
}

export function SkillHistoryDrawer({
  skillId,
  skillName,
  personalityId,
  open,
  onClose,
}: {
  skillId: string;
  skillName: string;
  personalityId?: string | undefined;
  open: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const scope = scopeKey(personalityId);
  const input = { id: skillId, ...(personalityId ? { personalityId } : {}) };

  const historyQuery = useQuery({
    queryKey: ['skills', 'history', scope, skillId],
    queryFn: () => rpc.skills.history(input),
    enabled: open,
  });
  // Newest first reads like a log; the diff below always runs older -> newer.
  const rows = useMemo(
    () => [...(historyQuery.data?.versions ?? [])].reverse(),
    [historyQuery.data],
  );
  const head = rows[0];

  const [picked, setPicked] = useState<{ base?: string; target?: string }>({});
  const targetId = picked.target ?? head?.versionId;
  const baseId =
    picked.base ?? (rows[0]?.versionId === targetId ? rows[1]?.versionId : rows[0]?.versionId);

  const baseQuery = useVersionBytes(skillId, personalityId, baseId, open);
  const targetQuery = useVersionBytes(skillId, personalityId, targetId, open);

  const diff = useMemo(() => {
    if (!targetQuery.data) return null;
    const before = baseId === undefined ? null : (baseQuery.data?.content ?? null);
    if (baseId !== undefined && !baseQuery.data) return null;
    return unifiedDiff(before, targetQuery.data.content ?? '');
  }, [baseId, baseQuery.data, targetQuery.data]);

  const restoreMut = useMutation({
    mutationFn: (versionId: string) => rpc.skills.restore({ ...input, versionId }),
    onSuccess: () => {
      refreshSkillLists(qc, personalityId);
      qc.invalidateQueries({ queryKey: ['skills', 'history'] });
      setPicked({});
      notification.success({ message: 'Restored as a new version', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({ message: 'Restore failed', description: (err as Error).message }),
  });

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={`History — ${skillName}`}
      width={560}
      destroyOnClose
    >
      {historyQuery.isLoading ? (
        <div style={{ display: 'grid', placeItems: 'center', height: 160 }}>
          <Spin />
        </div>
      ) : historyQuery.error ? (
        <Typography.Text type="danger">
          Failed to load history: {(historyQuery.error as Error).message}
        </Typography.Text>
      ) : rows.length === 0 ? (
        <Typography.Text type="secondary">
          No versions yet. The first change to this skill starts its history.
        </Typography.Text>
      ) : (
        <>
          <div data-testid="skill-version-list">
            {rows.map((v) => (
              <div
                key={v.versionId}
                data-testid="skill-version-row"
                data-version-id={v.versionId}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 0',
                  borderBottom: '1px solid var(--ethos-border)',
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span className="learning-chip">{SOURCE_LABELS[v.source]}</span>
                    <span style={{ fontSize: 12 }}>{v.actor}</span>
                    <span style={{ fontSize: 12, color: 'var(--ethos-text-tertiary)' }}>
                      {formatWhen(v.at)}
                    </span>
                  </div>
                  {detailOf(v) ? (
                    <div style={{ fontSize: 12, color: 'var(--ethos-text-tertiary)' }}>
                      {detailOf(v)}
                    </div>
                  ) : null}
                </div>
                <Button
                  size="small"
                  type={baseId === v.versionId ? 'primary' : 'default'}
                  aria-pressed={baseId === v.versionId}
                  data-testid={`skill-diff-base-${v.versionId}`}
                  onClick={() => setPicked((p) => ({ ...p, base: v.versionId }))}
                >
                  From
                </Button>
                <Button
                  size="small"
                  type={targetId === v.versionId ? 'primary' : 'default'}
                  aria-pressed={targetId === v.versionId}
                  data-testid={`skill-diff-target-${v.versionId}`}
                  onClick={() => setPicked((p) => ({ ...p, target: v.versionId }))}
                >
                  To
                </Button>
                {v.versionId === head?.versionId ? null : (
                  <Popconfirm
                    title="Restore this version?"
                    description="It becomes a new version on top; nothing is lost."
                    okText="Restore"
                    onConfirm={() => restoreMut.mutate(v.versionId)}
                  >
                    <Button
                      size="small"
                      data-testid={`skill-restore-${v.versionId}`}
                      loading={restoreMut.isPending && restoreMut.variables === v.versionId}
                    >
                      Restore
                    </Button>
                  </Popconfirm>
                )}
              </div>
            ))}
          </div>

          <div
            style={{
              fontSize: 11,
              fontWeight: 500,
              color: 'var(--text-tertiary)',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              margin: '20px 0 8px',
            }}
          >
            Changes
          </div>
          {diff === null ? (
            <Spin size="small" />
          ) : (
            <div className="learning-diff" data-testid="skill-diff">
              {diff.map((line, i) => (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: diff lines have no id; order is fixed
                  key={i}
                  className={`learning-diff-line learning-diff-${line.kind}`}
                  data-kind={line.kind}
                >
                  {`${line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '} ${line.text}`}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </Drawer>
  );
}
