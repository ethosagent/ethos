import { describe, expect, it } from 'vitest';
import { resolveSmallWindowMode, scaleHistoryLimit } from '../model-catalog';

describe('Phase 4 — resolveSmallWindowMode', () => {
  it('activates on a window at or below 32k', () => {
    expect(resolveSmallWindowMode({ contextWindow: 16_000, staticTokens: 1_000 })).toBe(true);
    expect(resolveSmallWindowMode({ contextWindow: 32_000, staticTokens: 1_000 })).toBe(true);
  });

  it('activates on a larger window when static overhead exceeds 40%', () => {
    // 64k window, ~30k static (SOUL + tools) → 46% > 40% → small-window.
    expect(resolveSmallWindowMode({ contextWindow: 64_000, staticTokens: 30_000 })).toBe(true);
  });

  it('stays off on a large window with modest static overhead', () => {
    expect(resolveSmallWindowMode({ contextWindow: 200_000, staticTokens: 20_000 })).toBe(false);
    expect(resolveSmallWindowMode({ contextWindow: 64_000, staticTokens: 20_000 })).toBe(false);
  });

  it('honors the override', () => {
    expect(
      resolveSmallWindowMode({ contextWindow: 200_000, staticTokens: 1_000, override: 'on' }),
    ).toBe(true);
    expect(
      resolveSmallWindowMode({ contextWindow: 16_000, staticTokens: 1_000, override: 'off' }),
    ).toBe(false);
    expect(
      resolveSmallWindowMode({ contextWindow: 16_000, staticTokens: 1_000, override: 'auto' }),
    ).toBe(true);
  });

  it('never activates when the window is unknown', () => {
    expect(resolveSmallWindowMode({ contextWindow: undefined, staticTokens: 99_999 })).toBe(false);
  });
});

describe('Phase 4 — scaleHistoryLimit', () => {
  it('keeps the default 200 for frontier windows', () => {
    expect(scaleHistoryLimit(200_000)).toBe(200);
    expect(scaleHistoryLimit(128_000)).toBe(200);
  });

  it('scales down for small windows, clamped to [40, 200]', () => {
    expect(scaleHistoryLimit(16_000)).toBe(40);
    expect(scaleHistoryLimit(32_000)).toBe(80);
    expect(scaleHistoryLimit(64_000)).toBe(160);
  });

  it('returns the default when the window is unknown', () => {
    expect(scaleHistoryLimit(undefined)).toBe(200);
  });
});
