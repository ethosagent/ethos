import { describe, expect, it } from 'vitest';
import { emptyRow, rowsFromConfig, shouldRebuildRows } from '../lib/rows';

// F01 follow-up (plan/phases/architecture-suggestions-2026-09-10.md): a
// provider row loaded from `config.get` remembers which stored entry it came
// from, and the save sends that back as `sourceIndex`. The server overlays the
// row onto that entry (`overlayProviderRow`, apps/web-api config.service.ts),
// which is what keeps the key reference and the fields this editor never shows
// — `region`, `apiVersion`, `awsProfile`, unmodelled lines — through a save.
// The save half is pinned in `settings-patch-completeness.test.ts`; the server
// half by apps/web-api's `config-provider-chain.test.ts`.

const CHAIN = [
  { provider: 'anthropic', model: 'claude-opus-4-7', apiKeyPreview: 'sk-…abc1', baseUrl: null },
  { provider: 'bedrock', model: null, apiKeyPreview: '<unset>', baseUrl: null },
  { provider: 'azure', model: 'gpt-4o', apiKeyPreview: 'az-…9f00', baseUrl: 'https://x.azure' },
];

describe('rowsFromConfig', () => {
  it('stamps each loaded row with its position in config.get providers', () => {
    expect(rowsFromConfig(CHAIN).map((r) => r.sourceIndex)).toEqual([0, 1, 2]);
  });

  it('gives the legacy single-provider row and a new row no sourceIndex', () => {
    const [legacy] = rowsFromConfig([], 'anthropic', 'claude-opus-4-7', 'sk-…abc1', null);
    expect(legacy?.sourceIndex).toBeUndefined();
    expect(emptyRow().sourceIndex).toBeUndefined();
  });
});

describe('shouldRebuildRows', () => {
  it('rebuilds on first load and after a save or a refused save', () => {
    expect(shouldRebuildRows(false, undefined, 'v1')).toBe(true);
    expect(shouldRebuildRows(false, 'v1', 'v1')).toBe(true);
  });

  // A save that swaps two same-looking entries returns a response that is
  // deep-equal except for `providersVersion`; the rows must follow it.
  it('rebuilds when the stored chain is not the one the rows came from', () => {
    expect(shouldRebuildRows(true, 'v1', 'v2')).toBe(true);
  });

  it('keeps the rows while they still describe the stored chain', () => {
    expect(shouldRebuildRows(true, 'v1', 'v1')).toBe(false);
  });
});
