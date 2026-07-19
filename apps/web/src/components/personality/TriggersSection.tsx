import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Button, Input, InputNumber, Select, Typography } from 'antd';
import type { CSSProperties, ReactNode } from 'react';
import { useEffect, useState } from 'react';
import {
  mergeWebhooksForPersonality,
  type TriggerRowInput,
  type WebhookHookPatch,
} from '../../lib/webhook-merge';
import { rpc } from '../../rpc';

// Triggers — inbound webhooks bound to this personality (`webhooks.<hookId>.*`
// in config.yaml, binding via `webhooks.<hookId>.personalityId`). The editor
// lives here (moved from Settings) because the binding is per-personality: the
// page's personality is predefined, never chosen per row. Named "Triggers"
// (not "Webhooks") so watcher/cron ownership can join this section later.
//
// `config.update`'s `webhooks` field replaces the record across ALL
// personalities, so Save merges: this personality's rows + every other
// personality's hooks passed through untouched (see lib/webhook-merge).

let nextRowId = 1;

interface TriggerRow extends TriggerRowInput {
  /** Stable key for React list rendering. */
  _id: number;
  /** Redacted preview of the stored secret; the raw value never round-trips. */
  secretPreview: string;
}

type ConfigWebhooks = Awaited<ReturnType<typeof rpc.config.get>>['webhooks'];

function rowsFromConfig(webhooks: ConfigWebhooks, personalityId: string): TriggerRow[] {
  return Object.entries(webhooks)
    .filter(([, h]) => h.personalityId === personalityId)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([hookId, h]) => ({
      _id: nextRowId++,
      hookId,
      secret: '',
      secretPreview: h.secretPreview,
      sessionKey: h.sessionKey ?? '',
      prefilter: h.prefilter ?? '',
      prefilterTimeoutSeconds: h.prefilterTimeoutSeconds,
      mode: h.mode,
    }));
}

/** Same bordered-box style the Settings record editors use. */
const ROW_BOX_STYLE: CSSProperties = {
  border: '1px solid var(--ethos-border, #d9d9d9)',
  borderRadius: 'var(--radius-md)',
  padding: 12,
  marginBottom: 12,
};

function RowLabel({ children }: { children: ReactNode }) {
  return (
    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
      {children}
    </Typography.Text>
  );
}

export function TriggersSection({ personalityId }: { personalityId: string }) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const [rows, setRows] = useState<TriggerRow[]>([]);
  const [dirty, setDirty] = useState(false);

  const configQuery = useQuery({
    queryKey: ['config'],
    queryFn: () => rpc.config.get(),
  });

  useEffect(() => {
    if (!dirty && configQuery.data) {
      setRows(rowsFromConfig(configQuery.data.webhooks, personalityId));
    }
  }, [configQuery.data, dirty, personalityId]);

  const saveMut = useMutation({
    mutationFn: (webhooks: Record<string, WebhookHookPatch>) => rpc.config.update({ webhooks }),
    onSuccess: () => {
      setDirty(false);
      qc.invalidateQueries({ queryKey: ['config'] });
      notification.success({ message: 'Triggers saved', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({
        message: 'Save failed',
        description: err instanceof Error ? err.message : String(err),
      }),
  });

  const update = (index: number, patch: Partial<TriggerRow>) => {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
    setDirty(true);
  };
  const remove = (index: number) => {
    setRows((prev) => prev.filter((_, i) => i !== index));
    setDirty(true);
  };
  const add = () => {
    setRows((prev) => [
      ...prev,
      {
        _id: nextRowId++,
        hookId: '',
        secret: '',
        secretPreview: '',
        sessionKey: '',
        prefilter: '',
        prefilterTimeoutSeconds: null,
        mode: 'sync',
      },
    ]);
    setDirty(true);
  };

  const onSave = () => {
    const existing = configQuery.data?.webhooks;
    if (!existing) return;
    const result = mergeWebhooksForPersonality(existing, personalityId, rows);
    if (!result.ok) {
      notification.error({ message: result.error });
      return;
    }
    saveMut.mutate(result.webhooks);
  };

  if (!configQuery.data) return null;

  return (
    <div style={{ marginBottom: 32 }}>
      <Typography.Title level={5} style={{ marginBottom: 4 }}>
        Triggers
      </Typography.Title>
      <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
        Inbound webhooks that wake this personality. A POST to the hook URL with the bearer secret
        runs a turn as this personality. Other personalities&apos; hooks are untouched by saves
        here.
      </Typography.Paragraph>
      {rows.map((row, idx) => (
        <div key={row._id} style={ROW_BOX_STYLE}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 8,
            }}
          >
            <Typography.Text style={{ fontFamily: 'Geist Mono, monospace', fontSize: 12 }}>
              /webhook/{row.hookId || '<id>'}
            </Typography.Text>
            <Button size="small" danger onClick={() => remove(idx)}>
              Remove
            </Button>
          </div>
          <div style={{ marginBottom: 8 }}>
            <RowLabel>Hook id</RowLabel>
            <Input
              size="small"
              placeholder="github_ci"
              value={row.hookId}
              onChange={(e) => update(idx, { hookId: e.target.value })}
            />
          </div>
          <div style={{ marginBottom: 8 }}>
            <RowLabel>Secret</RowLabel>
            <Input.Password
              size="small"
              autoComplete="off"
              placeholder={row.secretPreview || 'generated on save'}
              value={row.secret}
              onChange={(e) => update(idx, { secret: e.target.value })}
            />
            {row.secretPreview && !row.secret ? (
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                Active: {row.secretPreview} — leave blank to keep it.
              </Typography.Text>
            ) : (
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                {row.secret
                  ? 'At least 8 characters.'
                  : 'Leave blank and the server generates one on save.'}
              </Typography.Text>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <div style={{ flex: 1 }}>
              <RowLabel>Session key (optional)</RowLabel>
              <Input
                size="small"
                placeholder="webhook:github"
                value={row.sessionKey}
                onChange={(e) => update(idx, { sessionKey: e.target.value })}
              />
            </div>
            <div style={{ width: 180 }}>
              <RowLabel>Mode</RowLabel>
              <Select
                size="small"
                style={{ width: '100%' }}
                value={row.mode}
                onChange={(v: 'sync' | 'ack') => update(idx, { mode: v })}
                options={[
                  { value: 'sync', label: 'sync — wait for reply' },
                  { value: 'ack', label: 'ack — 202 instantly' },
                ]}
              />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1 }}>
              <RowLabel>Prefilter script (optional, under ~/.ethos/scripts/)</RowLabel>
              <Input
                size="small"
                placeholder="filter.sh"
                value={row.prefilter}
                onChange={(e) => update(idx, { prefilter: e.target.value })}
              />
            </div>
            <div style={{ width: 180 }}>
              <RowLabel>Prefilter timeout (s)</RowLabel>
              <InputNumber
                size="small"
                style={{ width: '100%' }}
                min={1}
                max={600}
                precision={0}
                value={row.prefilterTimeoutSeconds}
                onChange={(v) => update(idx, { prefilterTimeoutSeconds: v ?? null })}
                disabled={!row.prefilter.trim()}
              />
            </div>
          </div>
        </div>
      ))}
      <Button type="dashed" size="small" onClick={add} style={{ width: '100%' }}>
        Add trigger
      </Button>
      {dirty ? (
        <Button
          type="primary"
          loading={saveMut.isPending}
          onClick={onSave}
          style={{ marginTop: 12, display: 'block' }}
        >
          Save triggers
        </Button>
      ) : null}
    </div>
  );
}
