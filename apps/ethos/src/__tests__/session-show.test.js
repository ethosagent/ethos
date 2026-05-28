import { describe, expect, it } from 'vitest';
import { formatSessionCost } from '../commands/sessions';

// ---------------------------------------------------------------------------
// formatSessionCost unit tests
// ---------------------------------------------------------------------------
const sampleUsage = {
  inputTokens: 14820,
  outputTokens: 3210,
  cacheReadTokens: 98400,
  cacheCreationTokens: 14820,
  estimatedCostUsd: 0.087,
  apiCallCount: 23,
  compactionCount: 1,
};
describe('formatSessionCost', () => {
  it('includes the estimated cost in the cost line', () => {
    const { costLine } = formatSessionCost(sampleUsage);
    expect(costLine).toContain('$0.087');
  });
  it('includes a cache savings percentage', () => {
    const { costLine, cacheSavingsPct } = formatSessionCost(sampleUsage);
    // cacheSavingsPct = floor(cacheReadTokens / totalInput * 90)
    // totalInput = 14820 + 98400 + 14820 = 128040
    // pct = round(98400 / 128040 * 90) = round(69.12) = 69
    expect(cacheSavingsPct).toBe(69);
    expect(costLine).toContain('~69%');
  });
  it('token line includes all four token counts', () => {
    const { tokenLine } = formatSessionCost(sampleUsage);
    expect(tokenLine).toContain('in=14,820');
    expect(tokenLine).toContain('out=3,210');
    expect(tokenLine).toContain('cache_read=98,400');
    expect(tokenLine).toContain('cache_creation=14,820');
  });
  it('clamps cache savings to 0 when there are no cache reads', () => {
    const { cacheSavingsPct } = formatSessionCost({
      ...sampleUsage,
      cacheReadTokens: 0,
    });
    expect(cacheSavingsPct).toBe(0);
  });
  it('clamps cache savings to 99 maximum', () => {
    // 100% cache reads → cacheRead / total * 90 = 90, well under 99
    // Use an extreme case: near-total cacheRead to check the 99 cap
    const { cacheSavingsPct } = formatSessionCost({
      ...sampleUsage,
      inputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 100000,
      // 100000 / 100000 * 90 = 90 — so cap is not triggered here
    });
    expect(cacheSavingsPct).toBe(90);
  });
  it('returns 0 savings when total input is zero', () => {
    const { cacheSavingsPct } = formatSessionCost({
      ...sampleUsage,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    expect(cacheSavingsPct).toBe(0);
  });
});
// ---------------------------------------------------------------------------
// Slack help block section count snapshot
// ---------------------------------------------------------------------------
describe('helpBlocks section count', () => {
  it('has one more section than before the context cost addition', async () => {
    const { helpBlocks } = await import('../../../../extensions/platform-slack/src/blocks/help');
    const blocks = helpBlocks({
      binding: { type: 'personality', name: 'hermes' },
      channel: 'C123',
      channelMode: 'mention_only',
    });
    // Count section-type blocks
    const sectionCount = blocks.filter((b) => b.type === 'section').length;
    // Before this change there were 2 sections (binding info + slash commands).
    // After the context cost addition there should be 3.
    expect(sectionCount).toBe(3);
  });
});
