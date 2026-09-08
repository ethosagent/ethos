import type { rpc } from '../rpc';

// Schema-driven tool-settings form (Phase 2, web-search-provider-selection).
//
// The form renders FROM a tool's `settingsSchema` — it has no tool-specific
// knowledge. This module holds the pure schema→control mapping so it can be
// unit-tested without a DOM. Types are inferred from the oRPC client (never
// cast) so they cannot drift from the contract.

type SchemasResult = Awaited<ReturnType<typeof rpc.toolSettings.schemas>>;
export type ToolSettingsSchemaWire = SchemasResult['tools'][number]['settingsSchema'];
export type ToolSettingsFieldWire = ToolSettingsSchemaWire['fields'][number];

/** A resolved form control — `enum` → Select, `secret` → SecretPicker,
 *  `info` → a static paragraph.
 *
 *  Every control carries a `key` so the form can render one list. For `info`
 *  it is a synthetic, position-derived id used only as a React key: an `info`
 *  field has no settings key by design, so it must never index the values map.
 */
export type ToolSettingsControl =
  | {
      kind: 'enum';
      key: string;
      label: string;
      options: Array<{ value: string; label: string }>;
      default?: string;
    }
  | { kind: 'secret'; key: string; label: string; secretKind: string; helpText?: string }
  | { kind: 'info'; key: string; label: string; text: string };

/** Map a tool's `settingsSchema` into the list of controls the form renders.
 *  Three kinds are supported today (enum, secret-binding, info). */
export function describeToolSettingsFields(schema: ToolSettingsSchemaWire): ToolSettingsControl[] {
  return schema.fields.map((field, index): ToolSettingsControl => {
    if (field.kind === 'info') {
      return { kind: 'info', key: `info:${index}`, label: field.label, text: field.text };
    }
    if (field.kind === 'enum') {
      return {
        kind: 'enum',
        key: field.key,
        label: field.label,
        options: field.options.map((o) => ({ value: o.value, label: o.label ?? o.value })),
        ...(field.default !== undefined ? { default: field.default } : {}),
      };
    }
    return {
      kind: 'secret',
      key: field.key,
      label: field.label,
      secretKind: field.secretKind,
      ...(field.helpText !== undefined ? { helpText: field.helpText } : {}),
    };
  });
}
