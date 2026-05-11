import type { ThemeConfig } from 'antd';
import type { Tokens } from './index';

// Antd-specific adapter. Maps the surface-agnostic `Tokens` shape onto
// Antd's ThemeConfig token names. Only the Web surface imports this entry,
// so TUI and CLI don't pay for the antd peer dep.
//
// Conversions handled here (not in consumer code):
//   • motion ms → s (Antd consumes seconds as a CSS string)
//   • per-component radius mapping (Card / Modal)
//   • DESIGN.md radius scale (4/8/14/full) — no off-scale literals

const msToCssSeconds = (ms: number): string => `${ms / 1000}s`;

export function tokensToAntd(tokens: Tokens): ThemeConfig {
  return {
    token: {
      fontFamily: tokens.typography.fontDisplay,
      fontFamilyCode: tokens.typography.fontMono,
      colorBgLayout: tokens.surface.bgBase,
      colorBgContainer: tokens.surface.bgElevated,
      colorBgElevated: tokens.surface.bgElevated,
      colorPrimary: tokens.accents.researcher ?? tokens.semantic.info,
      colorBorder: tokens.surface.borderSubtle,
      colorBorderSecondary: tokens.surface.borderStrong,
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
 * CSS variable block for layout dimensions. Inject into a `<style>` tag at
 * the app root so components can consume `var(--layout-sidebar-expanded)`
 * etc. instead of hardcoding pixel widths.
 */
export function tokensToLayoutCss(tokens: Tokens): string {
  const { layout } = tokens;
  return `:root {
  --layout-sidebar-expanded: ${layout.sidebarExpandedPx}px;
  --layout-sidebar-collapsed: ${layout.sidebarCollapsedPx}px;
  --layout-right-drawer: ${layout.rightDrawerPx}px;
  --layout-chat-max-width: ${layout.chatMaxWidthPx}px;
  --layout-onboarding-max-width: ${layout.onboardingMaxWidthPx}px;
}`;
}
