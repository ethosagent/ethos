import type { GuidanceMapping, InitiativeSettingsWire } from '@ethosagent/web-contracts';
import {
  Alert,
  App as AntApp,
  Button,
  Form,
  Input,
  InputNumber,
  Select,
  Spin,
  Switch,
  Typography,
} from 'antd';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { TabSaveBar } from '../../components/personality/TabSaveBar';
import { useInitiativeSettingsSave } from '../../features/initiative-settings/api/mutations';
import { useInitiativeSettings } from '../../features/initiative-settings/api/queries';
import { InitiativeMetrics } from './InitiativeMetrics';

// Personality → Initiatives (plan initiative-engine Task 6.3). Every
// `settings.yaml` key has a labeled control here; each control's wrapper carries
// `data-initiative-key="<dotted key>"`, which `initiatives-tab.test.ts` checks
// against `INITIATIVE_SETTINGS_FIELD_KEYS`. Saves go through the web-api
// InitiativesService (`rpc.initiatives.settingsSave`), the only writer of the
// file; the operator ceilings are shown read-only and edited in Settings.

type AutonomyMode = 'ask' | 'free_under' | 'free';

interface Draft {
  enabled: boolean;
  selfStart: boolean;
  dailyBudgetUsd: number;
  mode: AutonomyMode;
  askAboveUsd: number;
  ownerChannel: string;
  digestTime: string;
  guidance: string[];
}

const DEFAULT_ASK_ABOVE_USD = 1;

function toDraft(s: InitiativeSettingsWire): Draft {
  return {
    enabled: s.enabled,
    selfStart: s.selfStart,
    dailyBudgetUsd: s.dailyBudgetUsd,
    mode: s.defaultAutonomy?.mode ?? 'ask',
    askAboveUsd: s.defaultAutonomy?.askAboveUsd ?? DEFAULT_ASK_ABOVE_USD,
    ownerChannel: s.delivery?.ownerChannel ?? '',
    digestTime: s.delivery?.digestTime ?? '',
    guidance: s.standingGuidance,
  };
}

/** The full strict object `settingsSave` takes. An untouched absent block stays absent. */
function toSettings(d: Draft, stored: InitiativeSettingsWire): InitiativeSettingsWire {
  const autonomy =
    d.mode === 'free_under' ? { mode: d.mode, askAboveUsd: d.askAboveUsd } : { mode: d.mode };
  const channel = d.ownerChannel.trim();
  const time = d.digestTime.trim();
  return {
    enabled: d.enabled,
    selfStart: d.selfStart,
    dailyBudgetUsd: d.dailyBudgetUsd,
    ...(stored.defaultAutonomy || d.mode !== 'ask' ? { defaultAutonomy: autonomy } : {}),
    ...(channel && time ? { delivery: { ownerChannel: channel, digestTime: time } } : {}),
    standingGuidance: d.guidance.map((g) => g.trim()).filter(Boolean),
  };
}

/** Delivery is all-or-nothing: the schema requires both once either is set. */
function deliveryError(d: Draft): string | null {
  const half = Boolean(d.ownerChannel.trim()) !== Boolean(d.digestTime.trim());
  return half ? 'Set both the channel and the time, or clear both.' : null;
}

const usd = (n: number | undefined) => (n === undefined ? 'no ceiling set' : `$${n}`);

/** What `mapGuidance` made of one saved line. */
export function guidanceLabel(line: string, mappings: readonly GuidanceMapping[]): string {
  const found = mappings.find((m) => m.text === line.trim());
  if (!found) return 'not mapped yet, save to check';
  if (found.status === 'mapped') return found.mapsTo.join(', ');
  return found.status;
}

export function InitiativesTab({
  id,
  onDirtyChange,
}: {
  id: string;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const query = useInitiativeSettings(id);
  const save = useInitiativeSettingsSave(id);
  const { notification } = AntApp.useApp();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [clamps, setClamps] = useState<string[]>([]);

  const data = query.data;
  useEffect(() => {
    if (data) setDraft(toDraft(data.settings));
  }, [data]);

  if (query.isError) {
    return <Alert type="error" showIcon message="Could not load initiative settings" />;
  }
  if (!data) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 240 }}>
        <Spin />
      </div>
    );
  }

  const d = draft ?? toDraft(data.settings);
  const stored = data.settings;
  const baseline = toDraft(stored);
  const dirty = JSON.stringify(d) !== JSON.stringify(baseline);
  const problem = deliveryError(d);
  const patch = (next: Partial<Draft>) => setDraft({ ...d, ...next });
  const setLine = (i: number, text: string) =>
    patch({ guidance: d.guidance.map((g, j) => (j === i ? text : g)) });

  function onSave() {
    if (problem) {
      notification?.error({ message: 'Not saved', description: problem });
      return;
    }
    save.mutate(
      { personalityId: id, settings: toSettings(d, stored) },
      {
        onSuccess: (out) => {
          setClamps(out.clamps);
          setDraft(toDraft(out.saved));
          notification?.success({ message: 'Initiative settings saved', placement: 'topRight' });
        },
        onError: (err) => notification?.error({ message: 'Save failed', description: err.message }),
      },
    );
  }

  return (
    <Form layout="vertical">
      <InitiativeMetrics id={id} />
      {data.status === 'missing' ? (
        <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
          No settings file yet. These are the defaults; saving creates it.
        </Typography.Paragraph>
      ) : null}
      {data.status === 'invalid' ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="The settings file is invalid, so initiatives are paused for this personality"
          description={data.reason}
        />
      ) : null}

      <div data-initiative-key="enabled">
        <Form.Item
          label="Takes initiatives"
          extra="Off pauses every initiative for this personality."
        >
          <Switch
            checked={d.enabled}
            onChange={(v) => patch({ enabled: v })}
            aria-label="Takes initiatives"
          />
        </Form.Item>
      </div>
      <div data-initiative-key="selfStart">
        <Form.Item
          label="Can start its own initiatives"
          extra="It proposes explorations on its own, inside the operator's self-start pool."
        >
          <Switch
            checked={d.selfStart}
            onChange={(v) => patch({ selfStart: v })}
            aria-label="Can start its own initiatives"
          />
        </Form.Item>
      </div>
      <div data-initiative-key="dailyBudgetUsd">
        <Form.Item
          label="Daily budget (USD)"
          extra={
            <>
              Operator ceilings: {usd(data.ceilings.maxUsdPerDayPerPersonality)} per personality,{' '}
              {usd(data.ceilings.maxUsdPerDay)} across all. Set in{' '}
              <Link to="/settings/automation/initiatives">Settings → Automation → Initiatives</Link>
              .
            </>
          }
        >
          <InputNumber
            min={0}
            step={0.5}
            value={d.dailyBudgetUsd}
            onChange={(v) => patch({ dailyBudgetUsd: v ?? 0 })}
            aria-label="Daily budget (USD)"
          />
        </Form.Item>
      </div>
      <div data-initiative-key="defaultAutonomy.mode">
        <Form.Item
          label="Default autonomy"
          extra="Whether it asks before spending on an exploration. A single initiative can override this."
        >
          <Select<AutonomyMode>
            style={{ width: 240 }}
            value={d.mode}
            onChange={(v) => patch({ mode: v })}
            aria-label="Default autonomy"
            options={[
              { value: 'ask', label: 'Ask first' },
              { value: 'free_under', label: 'Free under a limit' },
              { value: 'free', label: 'Free' },
            ]}
          />
        </Form.Item>
      </div>
      {d.mode === 'free_under' ? (
        <div data-initiative-key="defaultAutonomy.askAboveUsd">
          <Form.Item
            label="Ask above (USD)"
            extra="Spends up to this much per exploration without asking."
          >
            <InputNumber
              min={0}
              step={0.5}
              value={d.askAboveUsd}
              onChange={(v) => patch({ askAboveUsd: v ?? DEFAULT_ASK_ABOVE_USD })}
              aria-label="Ask above (USD)"
            />
          </Form.Item>
        </div>
      ) : null}
      <div data-initiative-key="delivery.ownerChannel">
        <Form.Item
          label="Digest channel"
          extra="Where the digest goes, for example telegram:12345. Required once a digest time is set."
          validateStatus={problem ? 'error' : undefined}
          help={problem ?? undefined}
        >
          <Input
            value={d.ownerChannel}
            onChange={(e) => patch({ ownerChannel: e.target.value })}
            placeholder="platform:chat id"
            aria-label="Digest channel"
          />
        </Form.Item>
      </div>
      <div data-initiative-key="delivery.digestTime">
        <Form.Item label="Digest time" extra="Local time of day. Quiet hours still hold delivery.">
          <Input
            type="time"
            style={{ width: 160 }}
            value={d.digestTime}
            onChange={(e) => patch({ digestTime: e.target.value })}
            aria-label="Digest time"
          />
        </Form.Item>
      </div>
      <div data-initiative-key="standingGuidance">
        <Form.Item
          label="Standing guidance"
          extra="One line each. Advice about where to look, not permission: a line the personality has no tool for shows as unreachable."
        >
          {d.guidance.map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: lines have no identity; editing one must not remount the input
            <div key={i} style={{ marginBottom: 8 }}>
              <div style={{ display: 'flex', gap: 8 }}>
                <Input
                  value={line}
                  onChange={(e) => setLine(i, e.target.value)}
                  aria-label={`Guidance line ${i + 1}`}
                />
                <Button onClick={() => patch({ guidance: d.guidance.filter((_, j) => j !== i) })}>
                  Remove
                </Button>
              </div>
              <Typography.Text
                type="secondary"
                style={{ fontFamily: 'Geist Mono, monospace', fontSize: 12 }}
              >
                {guidanceLabel(line, data.guidance)}
              </Typography.Text>
            </div>
          ))}
          <Button onClick={() => patch({ guidance: [...d.guidance, ''] })}>Add a line</Button>
        </Form.Item>
      </div>

      {clamps.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginTop: 16 }}
          message="Saved, with limits applied"
          description={clamps.map((c) => <div key={c}>{c}</div>)}
        />
      ) : null}
      <TabSaveBar
        dirty={dirty}
        saving={save.isPending}
        saveSucceeded={save.isSuccess}
        onSave={onSave}
        onDirtyChange={onDirtyChange}
      />
    </Form>
  );
}
