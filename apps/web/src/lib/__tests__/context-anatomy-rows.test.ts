import type { ContextAnatomyWire } from '@ethosagent/web-contracts';
import { describe, expect, it } from 'vitest';
import { contextAnatomyRows, formatWindow } from '../context-anatomy-rows';

function anatomy(over: Partial<ContextAnatomyWire> = {}): ContextAnatomyWire {
  return {
    system: 1000,
    tools: 400,
    messages: 5000,
    total: 6400,
    inputTokens: 6400,
    cacheReadTokens: 0,
    cacheHitRate: 0,
    llmCallCount: 1,
    memory: 200,
    skills: 100,
    promptTokens: 6400,
    contextWindow: 200000,
    compactAtTokens: 100000,
    ...over,
  };
}

describe('contextAnatomyRows', () => {
  it('orders rows System, Memory, Skills, Tool schemas, Messages with System net of memory+skills', () => {
    const rows = contextAnatomyRows(anatomy());
    expect(rows.map((r) => r.key)).toEqual(['system', 'memory', 'skills', 'tools', 'messages']);
    expect(rows.map((r) => r.tokens)).toEqual([700, 200, 100, 400, 5000]);
    expect(rows.map((r) => r.approx)).toEqual([false, true, true, false, false]);
    expect(rows.map((r) => r.label)).toEqual([
      'System',
      'Memory',
      'Skills',
      'Tool schemas',
      'Messages',
    ]);
  });

  it('floors System at zero when memory+skills exceed it', () => {
    const rows = contextAnatomyRows(anatomy({ system: 100, memory: 200, skills: 100 }));
    expect(rows[0]?.tokens).toBe(0);
  });
});

describe('formatWindow', () => {
  it('uses an upper-case K suffix', () => {
    expect(formatWindow(200000)).toBe('200K');
    expect(formatWindow(1_000_000)).toBe('1M');
  });
});
