import { describe, expect, it } from 'vitest';
import { describeToolSettingsFields, type ToolSettingsSchemaWire } from '../tool-settings-form';

// The per-tool config form renders FROM a tool's settingsSchema. This exercises
// the pure schema→control mapping (DOM-free) — the same function the form uses.
const webSearchSchema: ToolSettingsSchemaWire = {
  fields: [
    {
      kind: 'enum',
      key: 'provider',
      label: 'Provider',
      options: [
        { value: 'exa', label: 'Exa' },
        { value: 'tavily' },
        { value: 'brave', label: 'Brave' },
      ],
    },
    { kind: 'secret-binding', key: 'secret', label: 'API key', secretKind: 'web-search' },
  ],
};

describe('describeToolSettingsFields', () => {
  it('maps enum → select control and secret-binding → secret control', () => {
    const controls = describeToolSettingsFields(webSearchSchema);
    expect(controls).toHaveLength(2);

    const provider = controls[0];
    const secret = controls[1];
    if (provider?.kind !== 'enum') throw new Error('expected enum control');
    expect(provider.key).toBe('provider');
    expect(provider.label).toBe('Provider');
    // A missing option label falls back to the value.
    expect(provider.options).toEqual([
      { value: 'exa', label: 'Exa' },
      { value: 'tavily', label: 'tavily' },
      { value: 'brave', label: 'Brave' },
    ]);

    if (secret?.kind !== 'secret') throw new Error('expected secret control');
    expect(secret.key).toBe('secret');
    expect(secret.secretKind).toBe('web-search');
  });

  it('returns an empty control list for a schema with no fields', () => {
    expect(describeToolSettingsFields({ fields: [] })).toEqual([]);
  });
});
