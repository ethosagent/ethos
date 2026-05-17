import { describe, expect, it } from 'vitest';
import {
  filterByAllowlist,
  type OpenRouterModelEntry,
  transformOpenRouterEntry,
} from '../sources/openrouter';
import fixture from './fixtures/openrouter-models.json';

describe('openrouter', () => {
  const models = fixture.data as OpenRouterModelEntry[];

  describe('filterByAllowlist', () => {
    it('filters to only allowed prefixes', () => {
      const filtered = filterByAllowlist(models);
      expect(filtered).toHaveLength(8);
      expect(filtered.map((m) => m.id)).not.toContain('cohere/command-r-plus');
      expect(filtered.map((m) => m.id)).not.toContain('unknown-provider/some-model');
    });
  });

  describe('transformOpenRouterEntry', () => {
    it('maps fields correctly with (OR) suffix', () => {
      const first = models[0];
      if (!first) throw new Error('fixture missing first entry');
      const result = transformOpenRouterEntry(first);
      expect(result).toEqual({
        id: 'anthropic/claude-opus-4-7',
        label: 'Claude Opus 4.7 (OR)',
        contextWindow: 200000,
      });
    });
  });
});
