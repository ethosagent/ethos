import { describe, expect, it } from 'vitest';
import {
  apportionSystemSections,
  contextMeterAttrs,
  meterGateTokens,
  sectionKindOf,
} from '../context-sections';

// biome-ignore lint/suspicious/noExplicitAny: minimal LLM stand-in
const llm = (maxContextTokens: number) => ({ maxContextTokens }) as any;

describe('apportionSystemSections', () => {
  it('splits by character share, rounding down', () => {
    expect(apportionSystemSections(1000, 4000, { memory: 1000, skills: 400 })).toEqual({
      memory: 250,
      skills: 100,
    });
  });

  it('never exceeds systemTokens, never negative (incl. sections larger than systemChars)', () => {
    let seed = 12345;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let i = 0; i < 500; i++) {
      const tokens = rnd(50_000);
      const chars = rnd(200_000);
      const r = apportionSystemSections(tokens, chars, {
        memory: rnd(300_000),
        skills: rnd(300_000),
      });
      expect(r.memory).toBeGreaterThanOrEqual(0);
      expect(r.skills).toBeGreaterThanOrEqual(0);
      expect(r.memory + r.skills).toBeLessThanOrEqual(tokens);
    }
  });

  it('returns zeros for zero inputs', () => {
    expect(apportionSystemSections(0, 100, { memory: 10, skills: 10 })).toEqual({
      memory: 0,
      skills: 0,
    });
    expect(apportionSystemSections(100, 0, { memory: 0, skills: 0 })).toEqual({
      memory: 0,
      skills: 0,
    });
  });
});

describe('sectionKindOf', () => {
  it('maps injector ids', () => {
    expect(sectionKindOf('skills')).toBe('skills');
    expect(sectionKindOf('memory-guidance')).toBe('memory');
    expect(sectionKindOf('team-memory-index:t')).toBe('memory');
    expect(sectionKindOf('file-context')).toBeUndefined();
    expect(sectionKindOf('other')).toBeUndefined();
  });
});

describe('contextMeterAttrs', () => {
  const requestTokens = { system: 1000, tools: 200, messages: 50 };

  it('uses gateWindowTokens over llm.maxContextTokens', () => {
    const a = contextMeterAttrs({
      llm: llm(200_000),
      gateWindowTokens: 64_000,
      systemPrompt: '',
      requestTokens,
    });
    expect(a.contextWindow).toBe(64_000);
    const b = contextMeterAttrs({ llm: llm(200_000), systemPrompt: '', requestTokens });
    expect(b.contextWindow).toBe(200_000);
  });

  it('omits window attrs when no window resolves but keeps systemSections', () => {
    const a = contextMeterAttrs({
      llm: llm(0),
      systemPrompt: 'abcd',
      systemSectionChars: { memory: 1, skills: 1 },
      requestTokens,
    });
    expect('contextWindow' in a).toBe(false);
    expect('compactAtTokens' in a).toBe(false);
    expect(a.systemSections).toBeDefined();
  });

  it('compactAtTokens equals meterGateTokens for the same inputs', () => {
    const compaction = {
      pressure: 0.75,
      maxContextTokens: 150_000,
      maxSingleToolResultTokens: 8_000,
    };
    const a = contextMeterAttrs({
      llm: llm(200_000),
      systemPrompt: '',
      compaction,
      maxCompletionTokens: 6_000,
      requestTokens,
    });
    expect(a.compactAtTokens).toBe(
      meterGateTokens({ llm: llm(200_000), reservedOutputTokens: 6_000, ...compaction }, 1200),
    );
  });

  it('honours gateWindowTokens in the gate', () => {
    const a = contextMeterAttrs({
      llm: llm(200_000),
      gateWindowTokens: 64_000,
      systemPrompt: '',
      requestTokens,
    });
    expect(a.compactAtTokens).toBe(
      meterGateTokens({ llm: llm(200_000), windowTokens: 64_000 }, 1200),
    );
  });

  it('omits compactAtTokens under server compaction', () => {
    const a = contextMeterAttrs({
      llm: llm(200_000),
      systemPrompt: '',
      serverCompactionActive: true,
      requestTokens,
    });
    expect(a.contextWindow).toBe(200_000);
    expect('compactAtTokens' in a).toBe(false);
  });

  it('without requestTokens only contextWindow is present', () => {
    const a = contextMeterAttrs({
      llm: llm(200_000),
      systemPrompt: 'x',
      systemSectionChars: { memory: 1, skills: 1 },
      requestTokens: undefined,
    });
    expect(a).toEqual({ contextWindow: 200_000 });
  });
});
