// TUI cost formatting mirrors the CLI's rule: two decimals, four below one
// cent (`formatCostUsd` in apps/ethos/src/lib/status-bar.ts — duplicated in
// App.tsx because apps/tui cannot import apps/ethos; CHANGE BOTH TOGETHER).
// /usage and /budget render through it, never a raw `toFixed(5)`.

import { describe, expect, it } from 'vitest';
import { formatCostUsd } from '../components/App';

describe('formatCostUsd (TUI copy of the CLI rule)', () => {
  it('two decimals at a cent and above, and for zero', () => {
    expect(formatCostUsd(0)).toBe('0.00');
    expect(formatCostUsd(0.01)).toBe('0.01');
    expect(formatCostUsd(1.23456)).toBe('1.23');
  });

  it('four decimals below one cent, so a tiny spend is not rendered as $0.00', () => {
    expect(formatCostUsd(0.0042)).toBe('0.0042');
    expect(formatCostUsd(0.00987)).toBe('0.0099');
  });
});
