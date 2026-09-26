import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The trail exists to show how fast the agent decided and acted, so the two
// layout promises that keep that visible live in CSS, not markup: the trail
// sits ABOVE the reply (DESIGN.md "Feedback & activity" rule 3), and a row's
// duration survives any argument length. Asserted against the stylesheet that
// ships — same technique as `features/voice/__tests__/call-row-css.test.ts`.

const css = readFileSync(join(import.meta.dirname, '..', '..', '..', 'styles.css'), 'utf8');

function block(selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  expect(start, `missing rule: ${selector}`).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf('}', start));
}

describe('trail layout stylesheet', () => {
  it('the assistant row stacks trail then bubble vertically', () => {
    // As a flex ROW the trail rendered beside the reply and squeezed it.
    const row = block('.message-row-assistant');
    expect(row).toContain('flex-direction: column');
    expect(row).toContain('align-items: stretch');
    // The row stays inside the 800px chat column.
    expect(block('.message-row')).toContain('max-width: var(--layout-chat-max-width)');
  });

  it('the trail can shrink to the column instead of widening it', () => {
    expect(block('.trail')).toContain('min-width: 0');
  });

  it('a long subject ellipsises on one line and gives up its width first', () => {
    const result = block('.activity-row-result');
    expect(result).toContain('flex: 1');
    expect(result).toContain('min-width: 0');
    expect(result).toContain('text-overflow: ellipsis');
    expect(result).toContain('white-space: nowrap');
  });

  it('the duration cell never shrinks and stays right-aligned in tabular figures', () => {
    const meta = block('.activity-row-meta');
    expect(meta).toContain('flex-shrink: 0');
    expect(meta).toContain('margin-left: auto');
    expect(block('.activity-row')).toContain('font-variant-numeric: tabular-nums');
  });

  it('the state cell (glyph + word) never shrinks either', () => {
    expect(block('.activity-row-state')).toContain('flex-shrink: 0');
    expect(block('.trail-decision-tag')).toContain('flex-shrink: 0');
  });
});
