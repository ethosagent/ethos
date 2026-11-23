import type { ContextAnatomyWire } from '@ethosagent/web-contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ContextMeter, ContextMeterPanel, meterState } from '../ContextMeter';

// The meter must never signal by colour alone: warning and over carry a ⚠
// glyph and an aria-label sentence. Static markup needs no DOM.

function anatomy(over: Partial<ContextAnatomyWire> = {}): ContextAnatomyWire {
  return {
    system: 1000,
    tools: 400,
    messages: 5000,
    total: 90_000,
    inputTokens: 6400,
    cacheReadTokens: 3200,
    cacheHitRate: 0.5,
    llmCallCount: 1,
    memory: 200,
    skills: 100,
    contextWindow: 200_000,
    compactAtTokens: 100_000,
    ...over,
  };
}

function meter(a: ContextAnatomyWire | null, used: number | null): string {
  return renderToStaticMarkup(
    createElement(ContextMeter, {
      anatomy: a,
      usedTokens: used,
      compactDisabled: false,
      onCompact: () => {},
    }),
  );
}

describe('meterState', () => {
  it('is normal below 90% of the compaction point', () => {
    expect(meterState(50_000, 100_000)).toBe('normal');
  });
  it('is warning from 90% up to the compaction point', () => {
    expect(meterState(90_000, 100_000)).toBe('warning');
    expect(meterState(99_999, 100_000)).toBe('warning');
  });
  it('is over at or past the compaction point', () => {
    expect(meterState(100_000, 100_000)).toBe('over');
    expect(meterState(120_000, 100_000)).toBe('over');
  });
  it('is normal when there is no compaction point', () => {
    expect(meterState(999_999, null)).toBe('normal');
  });
});

describe('ContextMeter', () => {
  it('shows a warning glyph, percent and aria-label near auto-compaction', () => {
    const html = meter(anatomy(), null);
    expect(html).toContain('⚠ 45%');
    expect(html).toContain('var(--warning)');
    expect(html).toContain('aria-label="Context: 45% of 200K used, near auto-compaction"');
    expect(html).toContain('type="button"');
    expect(html).toContain('<svg');
  });

  it('says past the auto-compaction point when over', () => {
    const html = meter(anatomy(), 120_000);
    expect(html).toContain('⚠ 60%');
    expect(html).toContain('past auto-compaction point');
  });

  it('shows a plain percent with no glyph when normal', () => {
    const html = meter(anatomy({ total: 40_000 }), null);
    expect(html).toContain('20%');
    expect(html).not.toContain('⚠');
    expect(html).toContain('aria-label="Context: 20% of 200K used"');
  });

  it('drops the ring when the window is unknown', () => {
    const html = meter(anatomy({ contextWindow: null, compactAtTokens: null }), null);
    expect(html).toContain('tokens');
    expect(html).not.toContain('<svg');
    expect(html).toContain('<button');
  });

  it('renders nothing with no anatomy and no usage', () => {
    expect(meter(null, null)).toBe('');
  });

  it('falls back to the legacy chip with usage but no anatomy', () => {
    const html = meter(null, 1200);
    expect(html).toContain('composer-context-meter');
    expect(html).toContain('1.2k tokens');
    expect(html).not.toContain('<button');
  });
});

describe('ContextMeterPanel', () => {
  function panel(a: ContextAnatomyWire, used: number, compactDisabled = false): string {
    return renderToStaticMarkup(
      createElement(ContextMeterPanel, { anatomy: a, used, compactDisabled, onCompact: () => {} }),
    );
  }

  it('lists the five rows with approximations marked', () => {
    const html = panel(anatomy(), 90_000);
    for (const label of ['System', 'Memory', 'Skills', 'Tool schemas', 'Messages']) {
      expect(html).toContain(label);
    }
    expect(html).toContain('≈ Memory');
    expect(html).toContain('≈ Skills');
    expect(html).not.toContain('≈ System');
    expect(html).toContain('auto-compacts here');
    expect(html).toContain('Cache hit 50%');
    expect(html).toContain('Compact now');
    expect(html).toContain('/compact &lt;focus&gt;');
    expect(html).not.toContain('Past the auto-compaction point');
  });

  it('states the over condition in words', () => {
    expect(panel(anatomy(), 120_000)).toContain(
      'Past the auto-compaction point — auto-compaction is due on a coming turn.',
    );
  });

  it('omits the tick when there is no compaction point', () => {
    expect(panel(anatomy({ compactAtTokens: null }), 90_000)).not.toContain('auto-compacts here');
  });

  it('disables Compact now when asked', () => {
    expect(panel(anatomy(), 90_000, true)).toMatch(/<button[^>]*disabled[^>]*>.*Compact now/);
  });
});
