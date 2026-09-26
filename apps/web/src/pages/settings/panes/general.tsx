// General — basics (default personality, appearance) and onboarding.
// Off `Card`, onto `SettingRow` (§4.2 rows 2, 3, 12; plan Phase 3).
//
// `Appearance` (`skin`) stays here, not in Chat & context — O1: it is a global
// display token every surface reads, not a chat-pane preference.

import { BUILTIN_SKIN_NAMES, BUILTIN_SKINS } from '@ethosagent/design-tokens';
import { Button, Form, Select } from 'antd';
import { useNavigate } from 'react-router-dom';
import { SectionHeading } from '../components/section-heading';
import { SelfSaveMarker } from '../components/self-save-marker';
import { SettingRow } from '../components/setting-row';
import type { ConfigGetData } from '../lib/config-types';
import { useSettingsPane } from '../pane-context';

/**
 * B3 (plan ux-feedback-and-config-clarity §6.2–6.3) — the `Resolved` block,
 * read-only at the top of General: which configuration is actually in effect.
 * The values come from `resolveEffectiveConfig` in `@ethosagent/config` via
 * `config.get`, the same resolver `ethos status` prints, so the two surfaces
 * cannot disagree. Dense rows, values in Geist Mono; not a `Card`.
 */
function ResolvedBlock({ resolved }: { resolved: ConfigGetData['resolved'] }) {
  const personalityNote =
    resolved.personality.source === 'activeContext'
      ? resolved.personality.shadowed
        ? `activeContext; personality: key says ${resolved.personality.shadowed}`
        : 'activeContext'
      : resolved.personality.source === 'personality'
        ? 'personality: key'
        : 'default — neither key set';
  const apiKeyNote =
    resolved.apiKey.source === 'env'
      ? `env ${resolved.apiKey.envVar ?? ''}${resolved.apiKey.overrides === 'vault' ? ', overrides vault' : ''}`
      : resolved.apiKey.source === 'vault'
        ? `vault ${resolved.apiKey.ref ?? ''}`
        : resolved.apiKey.source === 'inline'
          ? 'inline in config.yaml'
          : // A source this build does not know (a newer backend, e.g.
            // `missing`) renders verbatim rather than masquerading as inline.
            resolved.apiKey.source;
  const rows: Array<{ label: string; value: string; note?: string }> = [
    { label: 'state dir', value: resolved.stateDir },
    {
      label: 'config',
      value: resolved.configPath,
      ...(resolved.warnings.length > 0
        ? {
            note: `${resolved.warnings.length} ${
              resolved.warnings.length === 1 ? 'warning' : 'warnings'
            } — see the save bar`,
          }
        : {}),
    },
    { label: 'personality', value: resolved.personality.id, note: personalityNote },
    { label: 'model', value: resolved.model.id, note: resolved.model.rung },
    { label: 'api key', value: resolved.apiKey.provider, note: apiKeyNote },
  ];
  return (
    <div className="settings-resolved" data-testid="settings-resolved">
      <div className="settings-resolved-title">Resolved</div>
      {rows.map((row) => (
        <div key={row.label} className="settings-resolved-row">
          <span className="settings-resolved-label">{row.label}</span>
          <span className="settings-resolved-value">
            {row.value}
            {row.note ? <span className="settings-resolved-note"> ({row.note})</span> : null}
          </span>
        </div>
      ))}
    </div>
  );
}

export function GeneralPane() {
  const { config, personalities, personalitiesLoading } = useSettingsPane();
  const navigate = useNavigate();

  return (
    <>
      <SectionHeading id="basics">basics</SectionHeading>

      {/* Feature-detected: an older backend's `config.get` has no `resolved`
          and the pane must render without the block, not crash. */}
      {config?.resolved ? <ResolvedBlock resolved={config.resolved} /> : null}

      <SettingRow
        label="Personality"
        formName="personality"
        help="Used when chat doesn't override per-session."
      >
        <Form.Item
          name="personality"
          rules={[{ required: true, message: 'Required' }]}
          style={{ marginBottom: 0 }}
        >
          <Select
            loading={personalitiesLoading}
            options={personalities.map((p) => ({
              label: `${p.name}${p.builtin ? ' (built-in)' : ''}`,
              value: p.id,
            }))}
            showSearch
            optionFilterProp="label"
          />
        </Form.Item>
      </SettingRow>

      <SettingRow
        label="Skin"
        formName="skin"
        help="DESIGN.md baseline plus named overrides. Applies across all surfaces (Web, TUI)."
      >
        <Form.Item name="skin" style={{ marginBottom: 0 }}>
          <Select
            options={BUILTIN_SKIN_NAMES.map((name) => ({
              value: name,
              label: `${name} — ${BUILTIN_SKINS[name].description}`,
            }))}
          />
        </Form.Item>
      </SettingRow>

      <SectionHeading id="onboarding">onboarding</SectionHeading>

      <div className="settings-row">
        <div className="settings-row-info">
          <div className="settings-row-label">Setup wizard</div>
          <div className="settings-row-help">
            Re-run the guided setup to change your provider, model, personality, or messaging
            credentials.
          </div>
          <SelfSaveMarker />
        </div>
        <div className="settings-row-control">
          <Button onClick={() => navigate('/onboarding')}>Run setup wizard</Button>
        </div>
      </div>
    </>
  );
}
