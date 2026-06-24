import { describe, expect, it } from 'vitest';
import type { LearnRequest } from '../learn';
import { buildLearnPrompt, parseLearnArgs } from '../learn';

describe('parseLearnArgs', () => {
  it('parses remember: hint', () => {
    const result = parseLearnArgs('remember: user prefers dark mode');
    expect(result).toEqual({ hint: 'remember', description: 'user prefers dark mode' });
  });

  it('parses skill: hint', () => {
    const result = parseLearnArgs('skill: deploy workflow');
    expect(result).toEqual({ hint: 'skill', description: 'deploy workflow' });
  });

  it('parses input with no hint', () => {
    const result = parseLearnArgs('user likes TypeScript');
    expect(result).toEqual({ description: 'user likes TypeScript' });
  });

  it('handles empty input', () => {
    const result = parseLearnArgs('');
    expect(result).toEqual({ description: '' });
  });

  it('handles whitespace-only input', () => {
    const result = parseLearnArgs('   ');
    expect(result).toEqual({ description: '' });
  });

  it('trims surrounding whitespace', () => {
    const result = parseLearnArgs('  remember: dark mode  ');
    expect(result).toEqual({ hint: 'remember', description: 'dark mode' });
  });

  it('does not match remember in the middle of text', () => {
    const result = parseLearnArgs('I want to remember: things');
    expect(result).toEqual({ description: 'I want to remember: things' });
  });
});

describe('buildLearnPrompt', () => {
  const base: LearnRequest = {
    description: 'user prefers dark mode',
    personalityId: 'engineer',
    sessionKey: 'cli:project',
    surface: 'cli',
  };

  it('returns a string containing the personality id', () => {
    const prompt = buildLearnPrompt(base);
    expect(prompt).toContain('personality: engineer');
  });

  it('includes the description in the prompt', () => {
    const prompt = buildLearnPrompt(base);
    expect(prompt).toContain('user prefers dark mode');
  });

  it('includes memory_write instruction', () => {
    const prompt = buildLearnPrompt(base);
    expect(prompt).toContain('memory_write');
  });

  it('includes skill_propose instruction', () => {
    const prompt = buildLearnPrompt(base);
    expect(prompt).toContain('skill_propose');
  });

  it('includes distillation instruction', () => {
    const prompt = buildLearnPrompt(base);
    expect(prompt).toContain('Distill');
  });

  it('includes confirmation instruction', () => {
    const prompt = buildLearnPrompt(base);
    expect(prompt).toContain('Confirm Before Writing');
  });

  it('includes personality-scoped instruction', () => {
    const prompt = buildLearnPrompt(base);
    expect(prompt).toContain('PERSONALITY-SCOPED');
  });

  it('forces memory route when hint is remember', () => {
    const prompt = buildLearnPrompt({ ...base, hint: 'remember' });
    expect(prompt).toContain('Route this ONLY as a memory entry');
    expect(prompt).not.toContain('Route this ONLY as a skill proposal');
  });

  it('forces skill route when hint is skill', () => {
    const prompt = buildLearnPrompt({ ...base, hint: 'skill' });
    expect(prompt).toContain('Route this ONLY as a skill proposal');
    expect(prompt).not.toContain('Route this ONLY as a memory entry');
  });

  it('allows both routes when no hint', () => {
    const prompt = buildLearnPrompt(base);
    expect(prompt).toContain('Decide the best route');
  });

  it('uses session_search when description is empty', () => {
    const prompt = buildLearnPrompt({ ...base, description: '' });
    expect(prompt).toContain('session_search');
  });

  it('does not use session_search when description is provided', () => {
    const prompt = buildLearnPrompt(base);
    expect(prompt).not.toContain('session_search');
  });

  it('includes tool-grant intersection instruction', () => {
    const prompt = buildLearnPrompt(base);
    expect(prompt).toContain('personality toolset');
  });

  it('works for all surfaces', () => {
    for (const surface of ['cli', 'web', 'gateway'] as const) {
      const prompt = buildLearnPrompt({ ...base, surface });
      expect(prompt).toContain(`source: ${surface}`);
    }
  });

  it('includes untrusted data safety warning', () => {
    const prompt = buildLearnPrompt(base);
    expect(prompt).toContain('UNTRUSTED DATA');
  });
});
