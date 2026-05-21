import type {
  PersonalityConfig,
  PersonalityObservabilityConfig,
  PersonalitySafetyConfig,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';

describe('PersonalityConfig safety.observability schema', () => {
  it('safety field is optional on PersonalityConfig', () => {
    const cfg: PersonalityConfig = {
      id: 'test',
      name: 'Test',
      model: 'claude-sonnet-4-6',
      memoryScope: 'per-personality',
    };
    expect(cfg.safety).toBeUndefined();
  });

  it('valid observability config shape', () => {
    const obs: PersonalityObservabilityConfig = {
      storeToolArgs: 'redacted',
      storeToolBodies: 'none',
      storeLlmPayloads: 'metadata',
      redactPatterns: ['SECRET-[A-Z0-9]+'],
    };
    expect(obs.storeToolArgs).toBe('redacted');
    expect(obs.redactPatterns).toHaveLength(1);
  });

  it('PersonalitySafetyConfig accepts observability sub-block', () => {
    const safety: PersonalitySafetyConfig = {
      observability: { storeToolBodies: 'full' },
    };
    expect(safety.observability?.storeToolBodies).toBe('full');
  });

  it('partial observability override is valid', () => {
    const cfg: PersonalityConfig = {
      id: 'test',
      name: 'Test',
      model: 'claude-sonnet-4-6',
      memoryScope: 'per-personality',
      safety: { observability: { storeToolBodies: 'redacted' } },
    };
    expect(cfg.safety?.observability?.storeToolBodies).toBe('redacted');
    expect(cfg.safety?.observability?.storeToolArgs).toBeUndefined();
  });
});
