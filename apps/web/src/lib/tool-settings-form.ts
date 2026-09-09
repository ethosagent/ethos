import type { rpc } from '../rpc';

// Schema-driven tool-settings form (Phase 2, web-search-provider-selection).
//
// The form renders FROM a tool's `settingsSchema` — it has no tool-specific
// knowledge. This module holds the pure schema→control mapping so it can be
// unit-tested without a DOM. Types are inferred from the oRPC client (never
// cast) so they cannot drift from the contract.

type SchemasResult = Awaited<ReturnType<typeof rpc.toolSettings.schemas>>;
export type ConfigurableToolWire = SchemasResult['tools'][number];
export type ToolSettingsSchemaWire = ConfigurableToolWire['settingsSchema'];
export type ToolSettingsFieldWire = ToolSettingsSchemaWire['fields'][number];

/** One form's worth of settings: the storage key it reads and writes, every
 *  tool that key covers, and the schema to render. */
export interface ToolSettingsGroup {
  /** The settings-map key — `settingsKey` when the tool declares one, else its
   *  name. Also what the service stores the binding under. */
  key: string;
  /** Names of the tools this one form configures, in registry order. */
  toolNames: string[];
  schema: ToolSettingsSchemaWire;
}

/**
 * Group configurable tools by the settings slot they write, so tools sharing
 * one credential get ONE form rather than one each.
 *
 * `youtube_search` and `youtube_comments` both declare `settingsKey: 'youtube'`
 * — one Google API key, one project, one quota pool — so two forms would write
 * two wire keys against one stored binding and silently discard whatever was
 * typed into the second. The first tool in a group supplies the schema; tools
 * that share a key share a credential and so declare the same fields.
 */
export function groupToolSettings(tools: ConfigurableToolWire[]): ToolSettingsGroup[] {
  const groups: ToolSettingsGroup[] = [];
  const byKey = new Map<string, ToolSettingsGroup>();
  for (const tool of tools) {
    const key = tool.settingsKey ?? tool.name;
    const existing = byKey.get(key);
    if (existing) {
      existing.toolNames.push(tool.name);
      continue;
    }
    const group: ToolSettingsGroup = { key, toolNames: [tool.name], schema: tool.settingsSchema };
    byKey.set(key, group);
    groups.push(group);
  }
  return groups;
}

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
