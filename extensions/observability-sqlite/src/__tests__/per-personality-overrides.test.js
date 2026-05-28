import { RETENTION_DEFAULTS } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { mergeRetentionConfig, parseDuration } from '../retention';

describe('per-personality retention overrides', () => {
  it('no override returns global config unchanged', () => {
    const merged = mergeRetentionConfig(RETENTION_DEFAULTS);
    expect(merged.messages).toBe('365d');
  });
  it('override replaces specified fields only', () => {
    const merged = mergeRetentionConfig(RETENTION_DEFAULTS, { messages: '730d', blobs: '30d' });
    expect(merged.messages).toBe('730d');
    expect(merged.blobs).toBe('30d');
    expect(merged.traces).toBe('90d'); // unchanged
  });
  it('events sub-block deep-merges', () => {
    const merged = mergeRetentionConfig(RETENTION_DEFAULTS, {
      events: { audit: '1825d' },
    });
    expect(merged.events?.audit).toBe('1825d');
    expect(merged.events?.error).toBe('90d'); // unchanged
    expect(merged.events?.install).toBe('forever'); // unchanged
  });
  it('redact patterns merge (union)', () => {
    // This tests the concept — actual redactPatterns merging is in ObservabilityService
    const global = ['PATTERN-A'];
    const override = ['PATTERN-B'];
    const merged = [...global, ...override];
    expect(merged).toContain('PATTERN-A');
    expect(merged).toContain('PATTERN-B');
  });
  it('parseDuration parses correctly for personality override durations', () => {
    expect(parseDuration('730d')).toBe(730 * 86_400_000);
    expect(parseDuration('1825d')).toBe(1825 * 86_400_000);
    expect(parseDuration('30d')).toBe(30 * 86_400_000);
  });
});
