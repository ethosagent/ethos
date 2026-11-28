// Settings → Automation → Initiatives (plan initiative-engine Task 6.3b): the
// constitution `initiatives` block. Owner only. Every key has one control,
// marked `data-initiative-key="<key>"`, which `initiatives-section.test.ts`
// checks against `CONSTITUTION_INITIATIVES_FIELD_KEYS`.
//
// Saves through `rpc.constitution.initiativesSave` (the web-api InitiativesService,
// the only writer of the block), so it does not ride the page Save bar and says
// so with `SelfSaveMarker`. The server is the enforcer of `readableRoots`
// (refuses `~/.ssh`); the check here is only a hint before the round trip.
//
// "Owner only" has no client-side role: the web UI is one owner session, and
// `constitution.*` is outside SCOPE_MAP so any other caller gets 403. The
// section hides itself when that refusal comes back (`isNonOwnerError`,
// pinned by `initiatives-section.test.ts` 'hidden for non-owner').

import type {
  ConstitutionInitiatives,
  ConstitutionInitiativesSaveBlock,
} from '@ethosagent/web-contracts';
import { Alert, App as AntApp, Button, Input, InputNumber, Switch, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { useConstitutionInitiativesSave } from '../../../features/initiative-settings/api/mutations';
import { useConstitutionInitiatives } from '../../../features/initiative-settings/api/queries';
import { SectionHeading } from '../components/section-heading';
import { SelfSaveMarker } from '../components/self-save-marker';
import { SettingRow } from '../components/setting-row';

const DEFAULT_POOL_USD = 0.5;
const DEFAULT_MAX_SELF_STARTED = 2;

interface Draft {
  enabled: boolean;
  maxUsdPerDay: number | null;
  maxUsdPerDayPerPersonality: number | null;
  selfStartPoolUsdPerDay: number;
  maxSelfStarted: number;
  readableRoots: string[];
}

function toDraft(c: ConstitutionInitiatives): Draft {
  return {
    enabled: c.enabled ?? true,
    maxUsdPerDay: c.maxUsdPerDay ?? null,
    maxUsdPerDayPerPersonality: c.maxUsdPerDayPerPersonality ?? null,
    selfStartPoolUsdPerDay: c.selfStartPoolUsdPerDay ?? DEFAULT_POOL_USD,
    maxSelfStarted: c.maxSelfStarted ?? DEFAULT_MAX_SELF_STARTED,
    readableRoots: c.readableRoots ?? [],
  };
}

/** The full save body: every key but `readableRoots` is required; no ceiling is `null`. */
function toBlock(d: Draft, stored: ConstitutionInitiatives): ConstitutionInitiativesSaveBlock {
  const roots = d.readableRoots.map((r) => r.trim()).filter(Boolean);
  return {
    enabled: d.enabled,
    maxUsdPerDay: d.maxUsdPerDay,
    maxUsdPerDayPerPersonality: d.maxUsdPerDayPerPersonality,
    selfStartPoolUsdPerDay: d.selfStartPoolUsdPerDay,
    maxSelfStarted: d.maxSelfStarted,
    ...(stored.readableRoots !== undefined || roots.length > 0 ? { readableRoots: roots } : {}),
  };
}

/** Client-side hint only: any `.ssh` segment once `.`/`..` resolve. The server refuses it for real. */
export function refusesSsh(root: string): boolean {
  const out: string[] = [];
  for (const seg of root.trim().replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.includes('.ssh');
}

/** True when the server refused the caller (not the owner): the section then renders nothing. */
export function isNonOwnerError(err: unknown): boolean {
  if (!err || typeof err !== 'object' || !('code' in err)) return false;
  const code: unknown = Reflect.get(err, 'code');
  return code === 'FORBIDDEN' || code === 'UNAUTHORIZED';
}

export function InitiativesSection() {
  const query = useConstitutionInitiatives();
  const save = useConstitutionInitiativesSave();
  const { notification } = AntApp.useApp();
  const [draft, setDraft] = useState<Draft | null>(null);
  const data = query.data;
  useEffect(() => {
    if (data) setDraft(toDraft(data.initiatives));
  }, [data]);

  if (isNonOwnerError(query.error)) return null;
  // Nothing until the answer arrives, so an owner never sees the section flash in and out.
  if (!data) return null;

  const d = draft ?? toDraft(data.initiatives);
  const patch = (next: Partial<Draft>) => setDraft({ ...d, ...next });
  const refused = d.readableRoots.some(refusesSsh);
  const dirty = JSON.stringify(d) !== JSON.stringify(toDraft(data.initiatives));

  function onSave() {
    save.mutate(
      { initiatives: toBlock(d, data?.initiatives ?? {}) },
      {
        onSuccess: (out) =>
          notification?.success({
            message: 'Initiative limits saved',
            description: out.appliesOn,
            placement: 'topRight',
          }),
        onError: (err) => notification?.error({ message: 'Save failed', description: err.message }),
      },
    );
  }

  return (
    <>
      <SectionHeading id="initiatives">initiatives</SectionHeading>
      <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
        Limits apply at the next window; the rest of the constitution still needs a restart.
      </Typography.Paragraph>

      <div data-initiative-key="enabled">
        <SettingRow
          label="Initiatives enabled"
          help="The kill switch. Off overrides every personality's own switch."
        >
          <Switch
            checked={d.enabled}
            onChange={(v) => patch({ enabled: v })}
            aria-label="Initiatives enabled"
          />
        </SettingRow>
      </div>
      <div data-initiative-key="maxUsdPerDay">
        <SettingRow
          label="Daily spend, all personalities (USD)"
          help="Ceiling across every personality. Empty means no ceiling."
        >
          <InputNumber
            min={0}
            step={0.5}
            value={d.maxUsdPerDay}
            onChange={(v) => patch({ maxUsdPerDay: v })}
            aria-label="Daily spend, all personalities (USD)"
          />
        </SettingRow>
      </div>
      <div data-initiative-key="maxUsdPerDayPerPersonality">
        <SettingRow
          label="Daily spend per personality (USD)"
          help="Ceiling for one personality's daily budget; a higher budget is clamped on save."
        >
          <InputNumber
            min={0}
            step={0.5}
            value={d.maxUsdPerDayPerPersonality}
            onChange={(v) => patch({ maxUsdPerDayPerPersonality: v })}
            aria-label="Daily spend per personality (USD)"
          />
        </SettingRow>
      </div>
      <div data-initiative-key="selfStartPoolUsdPerDay">
        <SettingRow
          label="Self-start pool per day (USD)"
          help="What agent-started initiatives may spend per day, across all personalities."
        >
          <InputNumber
            min={0}
            step={0.25}
            value={d.selfStartPoolUsdPerDay}
            onChange={(v) => patch({ selfStartPoolUsdPerDay: v ?? DEFAULT_POOL_USD })}
            aria-label="Self-start pool per day (USD)"
          />
        </SettingRow>
      </div>
      <div data-initiative-key="maxSelfStarted">
        <SettingRow
          label="Agent-started initiatives allowed"
          help="How many initiatives the agent may have open at once."
        >
          <InputNumber
            min={0}
            precision={0}
            value={d.maxSelfStarted}
            onChange={(v) => patch({ maxSelfStarted: v ?? DEFAULT_MAX_SELF_STARTED })}
            aria-label="Agent-started initiatives allowed"
          />
        </SettingRow>
      </div>
      <div data-initiative-key="readableRoots">
        <SettingRow
          label="Readable folders"
          help="Folders an initiative may read beyond the personality's own reach. Empty means none. ~/.ssh is always refused."
        >
          <div>
            {d.readableRoots.map((root, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: roots have no identity; editing one must not remount the input
              <div key={i} style={{ marginBottom: 8 }}>
                <div style={{ display: 'flex', gap: 8 }}>
                  <Input
                    value={root}
                    status={refusesSsh(root) ? 'error' : undefined}
                    onChange={(e) =>
                      patch({
                        readableRoots: d.readableRoots.map((r, j) =>
                          j === i ? e.target.value : r,
                        ),
                      })
                    }
                    aria-label={`Readable folder ${i + 1}`}
                  />
                  <Button
                    onClick={() =>
                      patch({ readableRoots: d.readableRoots.filter((_, j) => j !== i) })
                    }
                  >
                    Remove
                  </Button>
                </div>
                {refusesSsh(root) ? (
                  <Typography.Text type="danger" style={{ fontSize: 12 }}>
                    ~/.ssh is refused.
                  </Typography.Text>
                ) : null}
              </div>
            ))}
            <Button onClick={() => patch({ readableRoots: [...d.readableRoots, ''] })}>
              Add a folder
            </Button>
          </div>
        </SettingRow>
      </div>

      {refused ? (
        <Alert type="error" showIcon message="Remove the refused folder before saving." />
      ) : null}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12 }}>
        <Button
          type="primary"
          disabled={!dirty || refused}
          loading={save.isPending}
          onClick={onSave}
        >
          Save initiative limits
        </Button>
        <SelfSaveMarker />
      </div>
    </>
  );
}
