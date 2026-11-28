import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Input, Spin, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { TabSaveBar } from '../../components/personality/TabSaveBar';
import { rpc } from '../../rpc';
import {
  aliasProblems,
  describeNote,
  type MountDraft,
  sameMounts,
  worldSettingsHref,
} from './worlds-tab-logic';

// The Worlds tab of the personality editor (plan world-model Task 7.4). It is
// the control for personalities/<id>/worlds.yaml; the write goes through
// worlds.mountsSave (WorldConfigService), nothing else.

const MONO = { fontFamily: 'Geist Mono, monospace', fontSize: 12.5 } as const;

export function WorldsTab({
  id,
  onDirtyChange,
}: {
  id: string;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const qc = useQueryClient();
  const mountsQ = useQuery({
    queryKey: ['worlds', 'mounts', id],
    queryFn: () => rpc.worlds.mounts({ personalityId: id }),
  });
  const listQ = useQuery({
    queryKey: ['worlds', 'list'],
    queryFn: () => rpc.worlds.list({}),
  });

  const [draft, setDraft] = useState<MountDraft[]>([]);
  const [saved, setSaved] = useState<MountDraft[]>([]);
  useEffect(() => {
    if (!mountsQ.data) return;
    const next = mountsQ.data.mounts.map((m): MountDraft => {
      return m.as === undefined ? { world: m.world, mode: m.mode } : m;
    });
    setDraft(next);
    setSaved(next);
  }, [mountsQ.data]);

  const mut = useMutation({
    mutationFn: (mounts: MountDraft[]) => rpc.worlds.mountsSave({ personalityId: id, mounts }),
    onSuccess: (_r, mounts) => {
      setSaved(mounts);
      qc.invalidateQueries({ queryKey: ['worlds'] });
    },
  });

  if (mountsQ.isLoading || listQ.isLoading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 120 }}>
        <Spin />
      </div>
    );
  }
  if (mountsQ.isError) {
    return <Typography.Text type="danger">Could not load worlds.</Typography.Text>;
  }

  const titles = new Map((listQ.data?.worlds ?? []).map((w) => [w.id, w.title] as const));
  const effective = new Map((mountsQ.data?.effective ?? []).map((e) => [e.world, e] as const));
  const problems = aliasProblems(draft);
  const dirty = !sameMounts(draft, saved);
  const mounted = new Set(draft.map((m) => m.world));
  const available = (listQ.data?.worlds ?? [])
    .filter((w) => w.id.startsWith('world:') && !mounted.has(w.id.slice('world:'.length)))
    .map((w) => ({ slug: w.id.slice('world:'.length), title: w.title }));

  const update = (i: number, patch: (m: MountDraft) => MountDraft) =>
    setDraft((rows) => rows.map((m, j) => (j === i ? patch(m) : m)));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
        Worlds this personality can read or propose to. A mount only takes effect when the world
        lists this personality; the effective mode is shown per row.
      </Typography.Paragraph>

      <div
        data-private="true"
        style={{ display: 'flex', gap: 12, alignItems: 'baseline', flexWrap: 'wrap' }}
      >
        <span style={MONO}>{id} (private)</span>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          always mounted, read and write, owner only
        </Typography.Text>
      </div>

      {draft.map((m, i) => {
        const eff = effective.get(m.world);
        const problem = problems.get(i);
        const note = saved.some((s) => sameMounts([s], [m])) ? eff?.note : undefined;
        return (
          <div
            key={m.world}
            data-world={m.world}
            style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
          >
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={MONO}>{titles.get(`world:${m.world}`) ?? m.world}</span>
              <select
                aria-label={`Mode for ${m.world}`}
                value={m.mode}
                onChange={(e) =>
                  update(i, (x) => ({
                    ...x,
                    mode: e.target.value === 'propose' ? 'propose' : 'read',
                  }))
                }
              >
                <option value="read">read</option>
                <option value="propose">propose</option>
              </select>
              <Input
                size="small"
                style={{ width: 160 }}
                placeholder="alias (optional)"
                aria-label={`Alias for ${m.world}`}
                status={problem ? 'error' : undefined}
                value={m.as ?? ''}
                onChange={(e) =>
                  update(i, ({ as: _drop, ...rest }) =>
                    e.target.value === '' ? rest : { ...rest, as: e.target.value },
                  )
                }
              />
              <Button
                size="small"
                type="text"
                onClick={() => setDraft((rows) => rows.filter((_, j) => j !== i))}
              >
                Unmount
              </Button>
            </div>
            {eff && note === undefined ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                effective: {eff.effective}
              </Typography.Text>
            ) : null}
            {note !== undefined && eff ? (
              <Typography.Text type="warning" style={{ fontSize: 12 }}>
                effective: {eff.effective}. {describeNote(m.world, id, note)}.{' '}
                <Link to={worldSettingsHref(m.world)}>Open {m.world} settings</Link>
              </Typography.Text>
            ) : null}
            {problem ? (
              <Typography.Text type="danger" style={{ fontSize: 12 }} role="alert">
                {problem}
              </Typography.Text>
            ) : null}
          </div>
        );
      })}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <select
          aria-label="Mount a world"
          value=""
          disabled={available.length === 0}
          onChange={(e) => {
            const slug = e.target.value;
            if (slug !== '') setDraft((rows) => [...rows, { world: slug, mode: 'read' }]);
          }}
        >
          <option value="">{available.length === 0 ? 'No more worlds' : 'Mount a world…'}</option>
          {available.map((w) => (
            <option key={w.slug} value={w.slug}>
              {w.title}
            </option>
          ))}
        </select>
      </div>

      {mut.isError ? (
        <Typography.Text type="danger" role="alert">
          {mut.error instanceof Error ? mut.error.message : 'Save failed'}
        </Typography.Text>
      ) : null}

      <TabSaveBar
        dirty={dirty}
        saveDisabled={problems.size > 0}
        saving={mut.isPending}
        saveSucceeded={mut.isSuccess}
        onSave={() => {
          if (problems.size === 0) mut.mutate(draft);
        }}
        {...(onDirtyChange ? { onDirtyChange } : {})}
      />
    </div>
  );
}
