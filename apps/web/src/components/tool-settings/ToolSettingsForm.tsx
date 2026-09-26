import { QuestionCircleOutlined } from '@ant-design/icons';
import { Popover, Select, Typography } from 'antd';
import type { CSSProperties } from 'react';
import {
  describeToolSettingsFields,
  type ToolSettingsSchemaWire,
} from '../../lib/tool-settings-form';
import { SecretPicker } from './SecretPicker';

// Schema-driven tool-settings form. Renders FROM a tool's `settingsSchema` with
// no tool-specific knowledge: `enum` → Select, `secret-binding` → SecretPicker,
// `info` → a static paragraph.
// Reused for the global default (Settings) and the per-personality panel.
//
// An `info` row is READ-ONLY: no input, no state, and nothing written back into
// `value`. It is how a tool discloses a credential it does not bind itself (see
// `ToolSettingsInfoField` in @ethosagent/types).
//
// The one documented coupling: a `secret-binding` field is filtered by its own
// declared `provider` when it has one (one picker per namespace, `engine_ask`),
// else by the value of a sibling `provider` enum when present (`web_search`),
// so the picker only offers keys for the provider the tool will resolve under
// (`providers/<provider>/<name>`).

const SECTION_LABEL_STYLE: CSSProperties = {
  display: 'block',
  fontSize: 11,
  fontWeight: 500,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  marginBottom: 4,
};

export interface ToolSettingsFormProps {
  schema: ToolSettingsSchemaWire;
  /** fieldKey → value. Absent keys are unset. */
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  disabled?: boolean;
}

export function ToolSettingsForm({ schema, value, onChange, disabled }: ToolSettingsFormProps) {
  const controls = describeToolSettingsFields(schema);

  const setField = (key: string, next: string | undefined) => {
    const merged = { ...value };
    if (next === undefined || next === '') delete merged[key];
    else merged[key] = next;
    onChange(merged);
  };
  // A cleared picker keeps its key with an EMPTY value rather than dropping it:
  // the service patches a binding field by field, so an omitted field keeps
  // its stored name and only an empty one clears it (`mergeSecretBinding`,
  // apps/web-api/src/services/tool-settings.service.ts).
  const setSecretField = (key: string, next: string | undefined) => {
    onChange({ ...value, [key]: next ?? '' });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {controls.map((control) => (
        <div key={control.key}>
          <Typography.Text type="secondary" style={SECTION_LABEL_STYLE}>
            {control.label}
            {control.kind === 'secret' && control.helpText ? (
              <Popover content={control.helpText} trigger="click">
                <QuestionCircleOutlined style={{ marginLeft: 4, cursor: 'pointer' }} />
              </Popover>
            ) : null}
          </Typography.Text>
          {control.kind === 'info' ? (
            <Typography.Paragraph type="secondary" style={{ marginTop: 0, marginBottom: 0 }}>
              {control.text}
            </Typography.Paragraph>
          ) : control.kind === 'enum' ? (
            <Select
              style={{ minWidth: 220, width: '100%' }}
              value={value[control.key] ?? control.default ?? undefined}
              onChange={(v) => setField(control.key, v)}
              options={control.options}
              placeholder={`Select ${control.label.toLowerCase()}`}
              disabled={disabled}
              allowClear
            />
          ) : (
            <SecretPicker
              value={value[control.key] || undefined}
              onChange={(name) => setSecretField(control.key, name)}
              secretKind={control.secretKind}
              providerFilter={control.provider ?? value.provider}
              disabled={disabled}
            />
          )}
        </div>
      ))}
    </div>
  );
}
