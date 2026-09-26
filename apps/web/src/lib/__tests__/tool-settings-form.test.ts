import { describe, expect, it } from 'vitest';
import {
  bindingDisplayValue,
  clearBindingField,
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

  // plan engine-ask-per-engine-bindings D7 — a field's declared provider
  // narrows its picker; the form reads it before any sibling enum's value.
  it('carries a declared provider onto the secret control, and omits it otherwise', () => {
    const controls = describeToolSettingsFields({
      fields: [
        {
          kind: 'secret-binding',
          key: 'chatgpt',
          label: 'OpenAI key (chatgpt answer engine)',
          secretKind: 'answer-engine',
          provider: 'openai',
        },
        {
          kind: 'secret-binding',
          key: 'perplexity',
          label: 'Perplexity key (perplexity answer engine)',
          secretKind: 'answer-engine',
          provider: 'perplexity',
        },
      ],
    });
    expect(controls.map((c) => (c.kind === 'secret' ? c.provider : 'not-secret'))).toEqual([
      'openai',
      'perplexity',
    ]);

    const [unscoped] = describeToolSettingsFields(webSearchSchema).filter(
      (c) => c.kind === 'secret',
    );
    expect(unscoped).toBeDefined();
    expect(unscoped && 'provider' in unscoped).toBe(false);
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

// plan engine-ask-per-engine-bindings D3 / §9 M4 — a legacy
// `engine_ask: { secret }` is the ChatGPT binding. The Tools tab shows it
// under `chatgpt` (the probe row already says it is bound) without the stored
// row changing, so a save that leaves this form alone re-sends `secret`
// verbatim and nothing on disk moves from being viewed.
describe('legacy engine_ask alias on the Tools tab', () => {
  it('displays a legacy secret under chatgpt, and changes nothing else', () => {
    const stored = { secret: 'openai-key', perplexity: 'pplx-key' };
    expect(bindingDisplayValue('engine_ask', stored)).toEqual({
      secret: 'openai-key',
      perplexity: 'pplx-key',
      chatgpt: 'openai-key',
    });
    // The stored row is not mutated: it is what an untouched save sends.
    expect(stored).toEqual({ secret: 'openai-key', perplexity: 'pplx-key' });
  });

  it('a chatgpt that is present (even cleared) wins over the alias', () => {
    expect(bindingDisplayValue('engine_ask', { secret: 'a', chatgpt: 'b' }).chatgpt).toBe('b');
    expect(bindingDisplayValue('engine_ask', { secret: 'a', chatgpt: '' }).chatgpt).toBe('');
  });

  it('leaves every other key alone', () => {
    const row = { secret: 'xai-key' };
    expect(bindingDisplayValue('x_search', row)).toBe(row);
    expect(bindingDisplayValue('engine_ask', {})).toEqual({});
  });

  // The server clears `chatgpt` AND retires `secret` on a Reset
  // (`mergeSecretBinding`, apps/web-api tool-settings.service.ts). Local state
  // must match, or the next save re-sends `secret` and re-binds the key.
  it('clearing chatgpt also drops the legacy secret from local state', () => {
    expect(
      clearBindingField('engine_ask', { secret: 'openai-key', perplexity: 'p' }, 'chatgpt'),
    ).toEqual({ perplexity: 'p' });
    expect(clearBindingField('engine_ask', { secret: 'a', chatgpt: '' }, 'chatgpt')).toEqual({});
    // Another engine's field retires nothing.
    expect(clearBindingField('engine_ask', { secret: 'a', perplexity: 'p' }, 'perplexity')).toEqual(
      { secret: 'a' },
    );
    // A one-provider tool's `secret` is its canonical field, not an alias.
    expect(clearBindingField('x_search', { secret: 'x' }, 'secret')).toEqual({});
    expect(clearBindingField('web_search', { provider: 'exa', secret: 'x' }, 'secret')).toEqual({
      provider: 'exa',
    });
  });
});
