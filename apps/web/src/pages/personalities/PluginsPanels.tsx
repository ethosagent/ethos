import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App as AntApp, Button, Empty, Input, Spin, Switch, Tag, Typography } from 'antd';
import { useState } from 'react';
import { TabSaveBar } from '../../components/personality/TabSaveBar';
import { rpc } from '../../rpc';

export function WizardPluginsTab({
  selected,
  onChange,
}: {
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const [installOpen, setInstallOpen] = useState(false);
  const [packageSpec, setPackageSpec] = useState('');

  const pluginsQuery = useQuery({
    queryKey: ['plugins', 'list'],
    queryFn: () => rpc.plugins.list(),
  });

  const installMut = useMutation({
    // No `personalityId`: this tab runs inside the create wizard, and the
    // personality does not exist until the wizard is submitted
    // (`rpc.personalities.create` in `CreateWizard`). The install is global — a
    // consent grant and no `plugins.lock` entry, like `ethos plugin install`
    // without `--personality`.
    mutationFn: () => rpc.plugins.install({ packageSpec: packageSpec.trim() }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['plugins', 'list'] });
      setPackageSpec('');
      setInstallOpen(false);
      notification.success({ message: 'Plugin installed', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({ message: 'Install failed', description: (err as Error).message }),
  });

  if (pluginsQuery.isLoading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 120 }}>
        <Spin />
      </div>
    );
  }

  const plugins = pluginsQuery.data?.plugins ?? [];
  const selectedSet = new Set(selected);

  function toggle(pluginId: string, on: boolean) {
    const next = new Set(selectedSet);
    if (on) next.add(pluginId);
    else next.delete(pluginId);
    onChange([...next]);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div>
        {installOpen ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
            <Input
              autoFocus
              placeholder="npm package name or path"
              value={packageSpec}
              onChange={(e) => setPackageSpec(e.target.value)}
              onPressEnter={() => installMut.mutate()}
              style={{ flex: 1 }}
            />
            <Button
              type="primary"
              size="small"
              loading={installMut.isPending}
              disabled={!packageSpec.trim()}
              onClick={() => installMut.mutate()}
            >
              Install
            </Button>
            <Button
              size="small"
              onClick={() => {
                setInstallOpen(false);
                setPackageSpec('');
              }}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <Button size="small" onClick={() => setInstallOpen(true)} style={{ marginBottom: 12 }}>
            Install plugin
          </Button>
        )}
      </div>
      {plugins.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <span>
              No plugins installed.{' '}
              <Typography.Text code>ethos plugin install &lt;path&gt;</Typography.Text>
            </span>
          }
        />
      ) : (
        <>
          {selectedSet.size === 0 ? (
            <Alert
              type="info"
              showIcon
              message="0 plugins attached"
              description="Toggle a plugin below to enable it for this personality."
              style={{ marginBottom: 4 }}
            />
          ) : null}
          {plugins.map((p) => (
            <div key={p.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <Switch
                size="small"
                checked={selectedSet.has(p.id)}
                onChange={(on) => toggle(p.id, on)}
                aria-label={`Attach ${p.name}`}
                style={{ marginTop: 2, flexShrink: 0 }}
              />
              <div>
                <div style={{ fontWeight: 500 }}>{p.name}</div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  <Typography.Text
                    style={{ fontFamily: 'Geist Mono, monospace', fontSize: 12 }}
                    type="secondary"
                  >
                    {p.id}
                  </Typography.Text>
                  <Tag bordered={false} style={{ fontSize: 11 }}>
                    {p.source}
                  </Tag>
                  {p.pluginContractMajor !== null ? (
                    <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                      v{p.pluginContractMajor}
                    </Typography.Text>
                  ) : null}
                </div>
                {p.description ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {p.description}
                  </Typography.Text>
                ) : null}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Plugins attach panel — toggle per plugin, optimistic updates.
// Saves via personalities.update({ plugins: [...] }).
// ---------------------------------------------------------------------------

export function PluginsAttachPanel({
  id,
  initialPlugins,
  onDirtyChange,
}: {
  id: string;
  initialPlugins: string[];
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  // Toggles used to write immediately. They are a draft now: a switch that
  // saves itself gives the user no way to know whether it landed, which is the
  // one thing this modal has to be trustworthy about.
  const [attached, setAttached] = useState<Set<string>>(new Set(initialPlugins));
  const [saved, setSaved] = useState<Set<string>>(new Set(initialPlugins));

  const pluginsQuery = useQuery({
    queryKey: ['plugins', 'list'],
    queryFn: () => rpc.plugins.list(),
  });

  const mut = useMutation({
    mutationFn: (next: string[]) => rpc.personalities.update({ id, plugins: next }),
    onSuccess: (_result, next) => {
      // No rollback of the draft on failure: the edits are the user's now, and
      // discarding them on a network error would be the silent loss this
      // change exists to remove.
      setSaved(new Set(next));
      qc.invalidateQueries({ queryKey: ['personalities', 'get', id] });
      qc.invalidateQueries({ queryKey: ['personalities', 'characterSheet', id] });
      qc.invalidateQueries({ queryKey: ['personalities', 'list'] });
      notification.success({ message: 'Plugins saved', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({ message: 'Save failed', description: (err as Error).message }),
  });

  const plugins = pluginsQuery.data?.plugins ?? [];
  const dirty = attached.size !== saved.size || [...attached].some((p) => !saved.has(p));

  if (pluginsQuery.isLoading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 120 }}>
        <Spin />
      </div>
    );
  }

  if (plugins.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={
          <span>
            No plugins installed.{' '}
            <Typography.Text code>ethos plugin install &lt;path&gt;</Typography.Text>
          </span>
        }
      />
    );
  }

  function toggle(pluginId: string, on: boolean) {
    const next = new Set(attached);
    if (on) next.add(pluginId);
    else next.delete(pluginId);
    setAttached(next);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {attached.size === 0 ? (
        <Alert
          type="info"
          showIcon
          message="0 plugins attached"
          description="Toggle a plugin below to enable it for this personality."
          style={{ marginBottom: 4 }}
        />
      ) : null}
      {plugins.map((p) => (
        <div key={p.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <Switch
            size="small"
            checked={attached.has(p.id)}
            disabled={mut.isPending}
            onChange={(on) => toggle(p.id, on)}
            aria-label={`Attach ${p.name} to ${id}`}
            style={{ marginTop: 2, flexShrink: 0 }}
          />
          <div>
            <div style={{ fontWeight: 500 }}>{p.name}</div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <Typography.Text
                style={{ fontFamily: 'Geist Mono, monospace', fontSize: 12 }}
                type="secondary"
              >
                {p.id}
              </Typography.Text>
              <Tag bordered={false} style={{ fontSize: 11 }}>
                {p.source}
              </Tag>
              {p.pluginContractMajor !== null ? (
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  v{p.pluginContractMajor}
                </Typography.Text>
              ) : null}
            </div>
            {p.description ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {p.description}
              </Typography.Text>
            ) : null}
          </div>
        </div>
      ))}
      <TabSaveBar
        dirty={dirty}
        saving={mut.isPending}
        saveSucceeded={mut.isSuccess}
        onSave={() => mut.mutate([...attached])}
        {...(onDirtyChange ? { onDirtyChange } : {})}
      />
    </div>
  );
}
