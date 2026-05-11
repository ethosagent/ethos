import { DEFAULT_TOKENS } from '@ethosagent/design-tokens';
import { tokensToAntd } from '@ethosagent/design-tokens/antd';
import type { ThemeConfig } from 'antd';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyReducedMotion,
  REDUCED_MOTION_STYLESHEET,
  watchReducedMotion,
} from '../reduced-motion';

const base: ThemeConfig = {
  ...tokensToAntd(DEFAULT_TOKENS),
};

describe('applyReducedMotion', () => {
  it('collapses every motionDuration token to "0s"', () => {
    const reduced = applyReducedMotion(base);
    expect(reduced.token?.motionDurationFast).toBe('0s');
    expect(reduced.token?.motionDurationMid).toBe('0s');
    expect(reduced.token?.motionDurationSlow).toBe('0s');
  });

  it('does not mutate the input theme', () => {
    const originalFast = base.token?.motionDurationFast;
    applyReducedMotion(base);
    expect(base.token?.motionDurationFast).toBe(originalFast);
    // Sanity: the base derives from DESIGN.md 80ms; never '0s'.
    expect(base.token?.motionDurationFast).toBe('0.08s');
  });

  it('leaves non-motion tokens untouched', () => {
    const reduced = applyReducedMotion(base);
    expect(reduced.token?.colorBgLayout).toBe(base.token?.colorBgLayout);
    expect(reduced.token?.fontFamily).toBe(base.token?.fontFamily);
    expect(reduced.token?.borderRadius).toBe(base.token?.borderRadius);
  });
});

describe('REDUCED_MOTION_STYLESHEET', () => {
  it('matches the DESIGN.md spec verbatim', () => {
    // DESIGN.md line 139:
    //   `prefers-reduced-motion` → all motion is instant.
    //   `* { transition: none !important; animation: none !important; }`
    expect(REDUCED_MOTION_STYLESHEET).toContain('* {');
    expect(REDUCED_MOTION_STYLESHEET).toContain('transition: none !important');
    expect(REDUCED_MOTION_STYLESHEET).toContain('animation: none !important');
  });
});

describe('watchReducedMotion', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('invokes the callback synchronously with the current preference', () => {
    const listeners = new Set<(e: MediaQueryListEvent) => void>();
    const fakeMedia = {
      matches: true,
      media: '(prefers-reduced-motion: reduce)',
      addEventListener: (_e: string, cb: (e: MediaQueryListEvent) => void) => {
        listeners.add(cb);
      },
      removeEventListener: (_e: string, cb: (e: MediaQueryListEvent) => void) => {
        listeners.delete(cb);
      },
    };
    vi.stubGlobal('window', {
      matchMedia: () => fakeMedia,
    });

    const cb = vi.fn();
    const teardown = watchReducedMotion(cb);
    expect(cb).toHaveBeenCalledWith(true);

    // Mid-session OS toggle.
    for (const listener of listeners)
      listener({ matches: false } as unknown as MediaQueryListEvent);
    expect(cb).toHaveBeenLastCalledWith(false);

    teardown();
    expect(listeners.size).toBe(0);
  });

  it('returns false + a no-op teardown on a server (no window)', () => {
    vi.stubGlobal('window', undefined);
    const cb = vi.fn();
    const teardown = watchReducedMotion(cb);
    expect(cb).toHaveBeenCalledWith(false);
    expect(typeof teardown).toBe('function');
    teardown(); // does not throw
  });
});
