import { useMutation, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, InputNumber, Radio, Switch } from 'antd';
import { useState } from 'react';
import { rpc } from '../../../rpc';
import type { ConfigGetData, ConfigUpdatePatch } from '../lib/config-types';
import { SettingRow } from './setting-row';

// Settings → Memory › World: the control for the six `world.*` keys (plan
// world-model Config surfaces, Task 7.3b). Every control saves on its own
// through `config.update` (ConfigRepository), one key per write, and shows the
// default when the key is absent: showing a default never writes it.
//
// Owner only. `config` is a cookie-only namespace (dual-auth.ts fails it closed
// for bearer keys), so `config.get` never answers a non-owner, and
// panes/memory.tsx renders this section only when `config.world` came back.
// Pinned by pages/__tests__/world-config-controls.test.ts.

type WorldSettings = ConfigGetData['world'];
type WorldPatch = NonNullable<ConfigUpdatePatch['world']>;

/** Commits on blur or Enter, and only when the value actually moved. */
function NumberControl({
  label,
  value,
  min,
  max,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onCommit: (n: number) => void;
}) {
  const [draft, setDraft] = useState<number | null>(value);
  const commit = () => {
    if (draft === null || !Number.isInteger(draft) || draft < min || draft > max) {
      setDraft(value);
      return;
    }
    if (draft !== value) onCommit(draft);
  };
  return (
    <InputNumber
      aria-label={label}
      min={min}
      max={max}
      precision={0}
      value={draft}
      onChange={(n) => setDraft(typeof n === 'number' ? n : null)}
      onBlur={commit}
      onPressEnter={commit}
    />
  );
}

export function WorldSettingsRows({ world }: { world: WorldSettings }) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const save = useMutation({
    mutationFn: (world: WorldPatch) => rpc.config.update({ world }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['config'] }),
    onError: (err) =>
      notification.error({ message: 'Save failed', description: (err as Error).message }),
  });
  const busy = save.isPending;

  return (
    <>
      <SettingRow
        label="World"
        help="Build a knowledge graph of people, teams and things you work with, and let personalities read it. Off means no world tools, no context and no extraction. Key: world.enabled."
      >
        <Switch
          aria-label="World"
          checked={world.enabled}
          disabled={busy}
          onChange={(enabled) => save.mutate({ enabled })}
        />
      </SettingRow>
      <SettingRow
        label="Context characters"
        help="Budget for the world block in each turn (0 to 8000, default 2400). Key: world.contextMaxChars."
      >
        <NumberControl
          label="Context characters"
          value={world.contextMaxChars}
          min={0}
          max={8000}
          onCommit={(contextMaxChars) => save.mutate({ contextMaxChars })}
        />
      </SettingRow>
      <SettingRow
        label="Context hops"
        help="How far from a mentioned entity the context follows links (default 2). Key: world.contextHops."
      >
        <Radio.Group
          aria-label="Context hops"
          value={world.contextHops}
          disabled={busy}
          onChange={(e) => save.mutate({ contextHops: e.target.value === 1 ? 1 : 2 })}
        >
          <Radio.Button value={1}>1</Radio.Button>
          <Radio.Button value={2}>2</Radio.Button>
        </Radio.Group>
      </SettingRow>
      <SettingRow
        label="Extraction"
        help="Propose facts found in conversations to the review queue (default off). Nothing is written to a world without your approval. Key: world.extraction."
      >
        <Switch
          aria-label="Extraction"
          checked={world.extraction === 'propose'}
          disabled={busy}
          onChange={(on) => save.mutate({ extraction: on ? 'propose' : 'off' })}
        />
      </SettingRow>
      <SettingRow
        label="Proposal cap"
        help="Most pending proposals kept per world (1 to 100000, default 500). Key: world.proposals.cap."
      >
        <NumberControl
          label="Proposal cap"
          value={world.proposals.cap}
          min={1}
          max={100_000}
          onCommit={(proposalsCap) => save.mutate({ proposalsCap })}
        />
      </SettingRow>
      <SettingRow
        label="Proposal TTL"
        help="Days a proposal waits before it expires (1 to 3650, default 30). Key: world.proposals.ttlDays."
      >
        <NumberControl
          label="Proposal TTL"
          value={world.proposals.ttlDays}
          min={1}
          max={3650}
          onCommit={(proposalsTtlDays) => save.mutate({ proposalsTtlDays })}
        />
      </SettingRow>
    </>
  );
}
