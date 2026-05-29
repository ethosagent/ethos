import { type ThemeConfig, theme } from 'antd';
import type { Tokens } from './index';

// Antd-specific adapter. Maps the surface-agnostic `Tokens` shape onto
// Antd's ThemeConfig token names. Only the Web surface imports this entry,
// so TUI and CLI don't pay for the antd peer dep.
//
// Conversions handled here (not in consumer code):
//   • motion ms → s (Antd consumes seconds as a CSS string)
//   • per-component radius mapping (Card / Modal)
//   • DESIGN.md radius scale (4/8/14/full) — no off-scale literals
//   • light vs dark algorithm — picked from the surface luminance so
//     a `paper`-style skin flips Antd to defaultAlgorithm and its
//     derived text / hover / border tokens land on light defaults

const msToCssSeconds = (ms: number): string => `${ms / 1000}s`;

function srgbToLinear(c: number): number {
  const channel = c / 255;
  return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

/**
 * WCAG relative luminance — 0 (black) to 1 (white). Used to decide whether
 * a skin's base surface is light or dark; the algorithm picker then hands
 * Antd the matching derived-token rules.
 */
export function surfaceLuminance(hex: string): number {
  const trimmed = hex.replace(/^#/, '');
  if (trimmed.length !== 6) return 0;
  const n = Number.parseInt(trimmed, 16);
  if (!Number.isFinite(n)) return 0;
  const r = srgbToLinear((n >>> 16) & 0xff);
  const g = srgbToLinear((n >>> 8) & 0xff);
  const b = srgbToLinear(n & 0xff);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** True when the resolved skin renders against a light background. */
export function isLightSurface(tokens: Tokens): boolean {
  return surfaceLuminance(tokens.surface.bgBase) > 0.5;
}

export function tokensToAntd(tokens: Tokens): ThemeConfig {
  const algorithm = isLightSurface(tokens) ? theme.defaultAlgorithm : theme.darkAlgorithm;
  return {
    algorithm,
    token: {
      fontFamily: tokens.typography.fontDisplay,
      fontFamilyCode: tokens.typography.fontMono,
      colorBgLayout: tokens.surface.bgBase,
      colorBgContainer: tokens.surface.bgElevated,
      colorBgElevated: tokens.surface.bgElevated,
      colorPrimary: tokens.accents.researcher ?? tokens.semantic.info,
      colorBorder: tokens.surface.borderSubtle,
      colorBorderSecondary: tokens.surface.borderStrong,
      colorText: tokens.surface.textPrimary,
      colorTextSecondary: tokens.surface.textSecondary,
      colorTextTertiary: tokens.surface.textTertiary,
      colorSuccess: tokens.semantic.success,
      colorWarning: tokens.semantic.warning,
      colorError: tokens.semantic.error,
      colorInfo: tokens.semantic.info,
      borderRadius: tokens.radius.md,
      motionDurationFast: msToCssSeconds(tokens.motion.fastMs),
      motionDurationMid: msToCssSeconds(tokens.motion.defaultMs),
      motionDurationSlow: msToCssSeconds(tokens.motion.slowMs),
      motionEaseOut: tokens.motion.ease,
      motionEaseInOut: tokens.motion.ease,
    },
    components: {
      Card: { borderRadius: tokens.radius.lg },
      Modal: { borderRadius: tokens.radius.md },
    },
  };
}

/**
 * Root-level CSS variables emitted from the resolved tokens. Injected by
 * the host (main.tsx) as a `<style>` block so the static stylesheet can
 * reference `var(--ethos-bg)` / `var(--layout-sidebar-expanded)` / etc.
 * and react to skin changes without a reload.
 *
 * Covers two slices:
 *   • surface — `--ethos-bg`, `--ethos-bg-elevated`, `--ethos-border`,
 *     `--ethos-text`, `--ethos-text-dim`. The legacy `--ethos-*` names are
 *     preserved so styles.css keeps working; the runtime values are now
 *     skin-aware (paper flips them to the light-mode column).
 *   • layout — `--layout-sidebar-expanded` etc. Same as before.
 */
export function tokensToCssVariables(tokens: Tokens): string {
  const { layout, surface } = tokens;
  const light = isLightSurface(tokens);
  return `:root {
  --ethos-bg: ${surface.bgBase};
  --ethos-bg-elevated: ${surface.bgElevated};
  --ethos-bg-overlay: ${surface.bgOverlay};
  --ethos-border: ${surface.borderSubtle};
  --ethos-border-strong: ${surface.borderStrong};
  --ethos-text: ${surface.textPrimary};
  --ethos-text-dim: ${surface.textSecondary};
  --ethos-text-tertiary: ${surface.textTertiary};
  --ethos-hover: ${light ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.07)'};
  --ethos-pressed: ${light ? 'rgba(0,0,0,0.09)' : 'rgba(255,255,255,0.12)'};
  --ethos-surface-tint: ${light ? 'rgba(0,0,0,0.03)' : 'rgba(255,255,255,0.04)'};
  --ethos-shadow-overlay: ${light ? 'rgba(0,0,0,0.12)' : 'rgba(0,0,0,0.5)'};
  --layout-sidebar-expanded: ${layout.sidebarExpandedPx}px;
  --layout-sidebar-collapsed: ${layout.sidebarCollapsedPx}px;
  --layout-right-drawer: ${layout.rightDrawerPx}px;
  --layout-chat-max-width: ${layout.chatMaxWidthPx}px;
  --layout-onboarding-max-width: ${layout.onboardingMaxWidthPx}px;
}`;
}

/**
 * @deprecated Use `tokensToCssVariables` — folds layout + surface into one
 * block so a single style injection covers all root-level vars. Kept as a
 * thin alias to avoid breaking external imports during the transition.
 */
export const tokensToLayoutCss = tokensToCssVariables;
