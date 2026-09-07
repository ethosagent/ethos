// @vitest-environment jsdom
//
// A personality editor may only offer a model this deployment can actually
// reach. Both provider Selects used to ship a hardcoded seven-entry list and
// both model AutoCompletes suggested from the full catalog, so a deployment
// with no Anthropic key was still offered `claude-opus-4-7` — and the tier map
// it wrote was inert anyway (`resolveModelWithTier`,
// packages/core/src/agent-loop/turn-context.ts).
//
// jsdom because importing the page module pulls in Antd; nothing here renders.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  configuredProviderIds,
  modelOptionsForProvider,
  providerOptionsFor,
} from '../Personalities';

describe('configuredProviderIds', () => {
  it('is the primary provider plus the fallback chain, de-duplicated', () => {
    expect(
      configuredProviderIds({
        provider: 'codex',
        providers: [{ provider: 'codex' }, { provider: 'openrouter' }],
      }),
    ).toEqual(['codex', 'openrouter']);
  });

  it('is empty when config has not loaded', () => {
    expect(configuredProviderIds(undefined)).toEqual([]);
  });
});

describe('providerOptionsFor', () => {
  it('offers only configured providers', () => {
    const options = providerOptionsFor(['codex']);
    expect(options.map((o) => o.value)).toEqual(['codex']);
    expect(options.map((o) => o.value)).not.toContain('anthropic');
  });

  it('keeps a value the personality already declares, flagged, so a save cannot erase it', () => {
    const options = providerOptionsFor(['codex'], 'anthropic');
    expect(options.map((o) => o.value)).toEqual(['codex', 'anthropic']);
    expect(options.find((o) => o.value === 'anthropic')?.label).toContain('(not configured)');
  });

  it('falls back to every known provider when config is unavailable', () => {
    const options = providerOptionsFor([]);
    expect(options.map((o) => o.value)).toContain('anthropic');
    expect(options.every((o) => !o.label.includes('(not configured)'))).toBe(true);
  });
});

describe('modelOptionsForProvider', () => {
  const catalog = {
    providers: {
      anthropic: {
        models: [{ id: 'claude-opus-4-7', label: 'Opus', contextWindow: 200_000 }],
      },
      codex: { models: [{ id: 'gpt-5.6-terra', label: 'Terra', contextWindow: 400_000 }] },
    },
  };

  it('suggests only the selected provider’s models', () => {
    expect(modelOptionsForProvider(catalog, 'codex').map((o) => o.value)).toEqual([
      'gpt-5.6-terra',
    ]);
  });

  it('suggests nothing for a provider the catalog does not carry', () => {
    expect(modelOptionsForProvider(catalog, 'ollama')).toEqual([]);
  });
});

// The hardcoded provider lists are the bug, so pin their removal at the source.
describe('the editor’s provider Selects', () => {
  const page = readFileSync(join(import.meta.dirname, '..', 'Personalities.tsx'), 'utf8');

  it('build their options from providerOptionsFor, not a literal list', () => {
    expect(page.match(/options=\{providerOptionsFor\(configured, /g)?.length).toBe(2);
    expect(page).not.toContain("{ label: 'OpenAI Compatible', value: 'openai-compat' },");
  });

  it('does not hand a hardcoded Anthropic model id to every deployment', () => {
    expect(page).not.toContain('placeholder="claude-opus-4-7"');
    expect(page).not.toContain('placeholder="claude-sonnet-4-6"');
    expect(page).not.toContain('placeholder="claude-haiku-4-5"');
  });
});
