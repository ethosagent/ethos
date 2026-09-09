import { describe, expect, it } from 'vitest';
import {
  describeToolSettingsFields,
  groupToolSettings,
  type ToolSettingsSchemaWire,
} from '../tool-settings-form';

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

  // An `info` field is a static disclosure — the way a tool that reads another
  // tool's credential (quora_search / linkedin_search / reddit_web_search, D3a)
  // says so where an operator looks for one. It has no settings key, so its
  // control key is synthetic and must never collide with a real field's key.
  it('maps info → a static control with no settings key', () => {
    const controls = describeToolSettingsFields({
      fields: [
        { kind: 'secret-binding', key: 'secret', label: 'API key', secretKind: 'web-search' },
        { kind: 'info', label: 'Web search credential', text: 'Uses the web_search binding.' },
      ],
    });
    expect(controls).toHaveLength(2);

    const info = controls[1];
    if (info?.kind !== 'info') throw new Error('expected info control');
    expect(info.label).toBe('Web search credential');
    expect(info.text).toBe('Uses the web_search binding.');
    expect(info.key).toBe('info:1');
    expect(info.key).not.toBe(controls[0]?.key);
  });
});

// `ToolSettingsValues` is keyed by the STORAGE slot, not the tool name. Two
// tools sharing one credential must therefore collapse into one form writing
// one key — otherwise the operator sees two identical credential forms, the
// second one's value is written under a key nothing reads, and whatever they
// typed there is silently discarded (plan/phases/search-console.md D24).
describe('groupToolSettings', () => {
  const youtubeSchema: ToolSettingsSchemaWire = {
    fields: [
      {
        kind: 'secret-binding',
        key: 'secret',
        label: 'Google API key (YouTube)',
        secretKind: 'youtube-api-key',
      },
    ],
  };

  it('renders one form per settingsKey, naming every tool it covers', () => {
    const groups = groupToolSettings([
      { name: 'web_search', settingsSchema: webSearchSchema },
      { name: 'youtube_search', settingsKey: 'youtube', settingsSchema: youtubeSchema },
      { name: 'youtube_comments', settingsKey: 'youtube', settingsSchema: youtubeSchema },
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]).toEqual({
      key: 'web_search',
      toolNames: ['web_search'],
      schema: webSearchSchema,
    });
    // One wire key for both tools, and the label says which two it configures.
    expect(groups[1]?.key).toBe('youtube');
    expect(groups[1]?.toolNames).toEqual(['youtube_search', 'youtube_comments']);
  });

  it('falls back to the tool name when no settingsKey is declared', () => {
    const groups = groupToolSettings([
      { name: 'web_search', settingsSchema: webSearchSchema },
      { name: 'x_search', settingsSchema: youtubeSchema },
    ]);
    expect(groups.map((g) => g.key)).toEqual(['web_search', 'x_search']);
  });
});
