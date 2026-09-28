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

    it('maps expiration_date to retiresOn and says so in the label', () => {
      // OpenRouter's /api/v1/models carries `expiration_date` ("2026-10-20")
      // on a model it will stop serving; a live-built catalog must keep the
      // retirement the static row carries (google/gemini-2.5-pro).
      const result = transformOpenRouterEntry({
        id: 'google/gemini-2.5-pro',
        name: 'Google: Gemini 2.5 Pro',
        context_length: 1048576,
        expiration_date: '2026-10-20',
      });
      expect(result.retiresOn).toBe('2026-10-20');
      expect(result.label).toContain('deprecated — retires 2026-10-20');
    });

    it('takes the date part of a timestamp and ignores a null or malformed date', () => {
      const base = { id: 'x/y', name: 'Y', context_length: 1000 };
      expect(
        transformOpenRouterEntry({ ...base, expiration_date: '2026-10-09T00:00:00Z' }).retiresOn,
      ).toBe('2026-10-09');
      expect(transformOpenRouterEntry({ ...base, expiration_date: null })).not.toHaveProperty(
        'retiresOn',
      );
      expect(transformOpenRouterEntry({ ...base, expiration_date: 'soon' })).not.toHaveProperty(
        'retiresOn',
      );
    });
  });
});
