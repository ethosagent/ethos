import type { ThemeConfig } from 'antd';

// `prefers-reduced-motion: reduce` honoring — DESIGN.md line 139:
// "* { transition: none !important; animation: none !important }". The
// reducer collapses every Antd motionDuration token to '0s' so primitives
// that animate via the theme (Modal, Drawer, Tabs) freeze. The companion
// stylesheet handles every other transition/animation in the codebase.
//
// Pulled into its own module so the logic is unit-testable without
// mounting React.

export const REDUCED_MOTION_STYLESHEET = `* { transition: none !important; animation: none !important; }`;

/**
 * Returns a copy of `base` with every motion duration collapsed to '0s'.
 * Antd's `motionEase*` tokens stay untouched — easing only matters when a
 * duration is non-zero, so we don't need to fight them.
 */
export function applyReducedMotion(base: ThemeConfig): ThemeConfig {
  return {
    ...base,
    token: {
      ...base.token,
      motionDurationFast: '0s',
      motionDurationMid: '0s',
      motionDurationSlow: '0s',
    },
  };
}

/**
 * Subscribe to OS reduced-motion preference changes. Calls `cb` with the
 * current value synchronously, then every time the preference flips.
 * Returns a teardown function. SSR-safe — returns the initial value as
 * `false` and a no-op teardown when window/matchMedia is unavailable.
 */
export function watchReducedMotion(cb: (reduced: boolean) => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    cb(false);
    return () => undefined;
  }
  const media = window.matchMedia('(prefers-reduced-motion: reduce)');
  cb(media.matches);
  const onChange = (event: MediaQueryListEvent) => cb(event.matches);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}
