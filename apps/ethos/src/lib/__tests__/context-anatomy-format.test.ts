import type { ContextAnatomy } from '@ethosagent/observability-sqlite';
import { describe, expect, it } from 'vitest';
import { formatContextAnatomy } from '../context-anatomy-format';

const id = (s: string) => s;
const style = { bold: id, dim: id };

function anatomy(over: Partial<ContextAnatomy> = {}): ContextAnatomy {
  return {
    system: 5000,
    tools: 900,
    messages: 3000,
    total: 8900,
    inputTokens: 100,
    cacheReadTokens: 800,
    cacheHitRate: 0.8,
    llmCallCount: 3,
    memory: 1200,
    skills: 800,
    promptTokens: 8900,
    contextWindow: 128000,
    compactAtTokens: 96000,
    ...over,
  };
}

describe('formatContextAnatomy', () => {
  it('splits memory and skills out of system and shows window and compaction point', () => {
    const out = formatContextAnatomy(anatomy(), style);
    expect(out).toContain('Context anatomy (latest of 3 llm calls)');
    expect(out).toContain('memory ≈');
    expect(out).toContain('1,200');
    expect(out).toContain('skills ≈');
    expect(out).toContain('800');
    expect(out).toMatch(/system\s+3,000 tok/);
    expect(out).toContain('of 128,000');
    expect(out).toContain('compacts at');
    expect(out).toContain('96,000');
    expect(out).toContain('cache hit');
    expect(out).toContain('80%');
    expect(out).toContain('≈ memory/skills split by size share');
  });

  it('says the window is unknown and prints no percentages when contextWindow is null', () => {
    const out = formatContextAnatomy(
      anatomy({ contextWindow: null, compactAtTokens: null }),
      style,
    );
    expect(out).toContain('window unknown');
    expect(out).not.toContain('% of');
    expect(out).not.toContain('compacts at');
  });

  it('floors the system row at zero and uses the singular for one call', () => {
    const out = formatContextAnatomy(anatomy({ system: 1000, llmCallCount: 1 }), style);
    expect(out).toContain('(latest of 1 llm call)');
    expect(out).toMatch(/system\s+0 tok/);
  });
});
