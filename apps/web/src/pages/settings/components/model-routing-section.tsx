// Settings → Models › per-personality routing, editable
// (plan/phases/model-registry.md T2.7). Each row is `modelRouting.<id>`: a
// personality Select × a role-or-alias Select. Every change is one
// `modelRegistry.setRouting` write, saved on its own; Remove writes `null`,
// which deletes the line. The declaration list is the registry — the four roles
// and the configured aliases — with no free-text path to a vendor id.
//
// This section is the ONLY writer of `modelRouting` from the web: the page Save
// no longer sends it (`buildConfigPatch`), because `config.update` merges the
// record and would put a removed override back.

import type { ModelRegistryRefusal } from '@ethosagent/web-contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Button, Select, Spin, Typography } from 'antd';
import { useState } from 'react';
import { rpc } from '../../../rpc';
import {
  declarationGroups,
  declarationLabel,
  modelRegistryKeys,
  type RoutingRow,
  routablePersonalityIds,
  routingRows,
} from '../lib/model-registry';
import { MONO, messageOf, RefusalNotice, TOOLBAR } from './model-registry-notices';
import { SelfSaveMarker } from './self-save-marker';
import { SettingTable } from './setting-table';

interface TableRow {
  key: string;
  personalityId: string | null;
  declaration: string | null;
  /** The stored override this row shows; null for the unsaved "Add override" row. */
  saved: RoutingRow | null;
}

const HINT = { fontSize: 12, color: 'var(--text-tertiary)' };

export function ModelRoutingSection({ personalityIds }: { personalityIds: readonly string[] }) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const listQuery = useQuery({
    queryKey: modelRegistryKeys.list(),
    queryFn: () => rpc.modelRegistry.list(),
  });
  const [draft, setDraft] = useState<{
    personalityId: string | null;
    declaration: string | null;
  } | null>(null);
  const [refusal, setRefusal] = useState<ModelRegistryRefusal | null>(null);

  async function setRouting(personalityId: string, declaration: string | null): Promise<boolean> {
    try {
      const result = await rpc.modelRegistry.setRouting({ personalityId, declaration });
      setRefusal(result.ok ? null : result);
      return result.ok;
    } catch (err) {
      notification.error({ message: 'Could not change routing', description: messageOf(err) });
      return false;
    } finally {
      await qc.invalidateQueries({ queryKey: modelRegistryKeys.all() });
    }
  }

  /** The new row writes once both halves are chosen. */
  async function editDraft(next: { personalityId: string | null; declaration: string | null }) {
    setDraft(next);
    if (next.personalityId === null || next.declaration === null) return;
    if (await setRouting(next.personalityId, next.declaration)) setDraft(null);
  }

  /** Moving an override to another personality: write the new line, then drop the old. */
  async function movePersonality(row: RoutingRow, personalityId: string) {
    if (personalityId === row.personalityId) return;
    if (await setRouting(personalityId, row.declaration)) {
      await setRouting(row.personalityId, null);
    }
  }

  if (listQuery.isLoading) return <Spin size="small" />;
  if (listQuery.error) {
    return (
      <Typography.Text type="danger">
        Failed to load routing: {messageOf(listQuery.error)}
      </Typography.Text>
    );
  }
  const list = listQuery.data;
  if (!list) return null;

  const rows: TableRow[] = routingRows(list.routing).map((r) => ({
    key: `saved:${r.personalityId}`,
    personalityId: r.personalityId,
    declaration: r.declaration,
    saved: r,
  }));
  if (draft) rows.push({ key: 'draft', ...draft, saved: null });

  const known = [...new Set([...personalityIds, ...Object.keys(list.routing)])].sort();
  const declarationOptions = declarationGroups(list).map((group) => ({
    label: group.label,
    options: group.options.map((o) => ({
      value: o.value,
      label: (
        <span style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
          <span style={MONO}>{o.name}</span>
          <span style={HINT}>{o.hint}</span>
        </span>
      ),
    })),
  }));

  return (
    <div className="settings-model-routing">
      <div style={TOOLBAR}>
        <SelfSaveMarker />
        <Button
          size="small"
          disabled={draft !== null}
          onClick={() => setDraft({ personalityId: null, declaration: null })}
        >
          Add override
        </Button>
      </div>
      {refusal ? <RefusalNotice refusal={refusal} /> : null}
      <SettingTable<TableRow>
        rowKey={(r) => r.key}
        rows={rows}
        emptyText="No overrides. Every personality runs on the model it declares."
        columns={[
          {
            key: 'personality',
            header: 'Personality',
            render: (row) => (
              <Select
                size="small"
                aria-label="Personality"
                placeholder="Choose a personality"
                showSearch
                optionFilterProp="value"
                value={row.personalityId ?? undefined}
                style={{ minWidth: 180 }}
                options={routablePersonalityIds(known, list.routing, row.personalityId).map(
                  (id) => ({ value: id, label: <span style={MONO}>{id}</span> }),
                )}
                onChange={(id: string) => {
                  if (row.saved) void movePersonality(row.saved, id);
                  else void editDraft({ personalityId: id, declaration: row.declaration });
                }}
              />
            ),
          },
          {
            key: 'declaration',
            header: 'Runs on',
            render: (row) => (
              <Select
                size="small"
                aria-label="Runs on"
                placeholder="Choose a role or model"
                value={row.declaration ?? undefined}
                style={{ minWidth: 200 }}
                options={declarationOptions}
                labelRender={({ value }) => (
                  <span style={MONO}>{declarationLabel(list, String(value))}</span>
                )}
                onChange={(declaration: string) => {
                  if (row.saved) void setRouting(row.saved.personalityId, declaration);
                  else void editDraft({ personalityId: row.personalityId, declaration });
                }}
              />
            ),
          },
          {
            key: 'actions',
            header: '',
            render: (row) => (
              <Button
                size="small"
                type="text"
                onClick={() => {
                  if (row.saved) void setRouting(row.saved.personalityId, null);
                  else setDraft(null);
                }}
              >
                Remove
              </Button>
            ),
          },
        ]}
      />
    </div>
  );
}
