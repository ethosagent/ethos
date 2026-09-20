import { DEFAULT_TOKENS } from '@ethosagent/design-tokens';
import { Platform, StyleSheet } from 'react-native';

// `src/theme` is the only place a hex or a font name appears. Everything is
// DEFAULT_TOKENS (dark, DESIGN.md's primary skin). Geist / Geist Mono are not
// in the repo, so content uses the platform font until they are embedded with
// the expo-font config plugin (R12) — D14's "never falls back to SF silently"
// is not yet met, and the README says so.
const t = DEFAULT_TOKENS;

export const color = {
  ...t.surface,
  ...t.semantic,
  /** Global chrome (tab bar, nav bar) stays `--info` at every altitude (D4). */
  chrome: t.semantic.info,
};

export const radius = t.radius;
export const space = t.spacing;
export const motion = t.motion;

/**
 * The iOS 26 floating (Liquid Glass) tab bar's own footprint — its pill height
 * plus the gap it floats above the safe area — NOT including the safe-area
 * bottom inset itself, which callers add separately (`tabBarBottomInset` in
 * `src/lib/tab-bar-inset.ts`). `NativeTabs` (`app/(tabs)/_layout.tsx`) renders
 * through react-native-screens' `Tabs.Host`, and neither expo-router nor
 * react-native-screens exposes a height hook for it — confirmed against
 * expo-router@57.0.22 / react-native-screens@4.26.2, and there is no
 * `@react-navigation/bottom-tabs` installed here for its `useBottomTabBarHeight`
 * to apply to. This is a fixed approximation of Apple's iOS 26 floating tab
 * bar (~49pt bar + ~15pt float gap) measured from screenshots, not a device —
 * re-measure and adjust this one constant if a screen's last row or the chat
 * composer still sits close to the pill after using it.
 */
export const TAB_BAR_PILL_HEIGHT = 64;

export const mono = Platform.select({ ios: 'Menlo', default: 'monospace' });

export const type = StyleSheet.create({
  body: { fontSize: t.typography.scale.body.px, color: color.textPrimary },
  small: { fontSize: t.typography.scale.small.px, color: color.textSecondary },
  h4: { fontSize: t.typography.scale.h4.px, fontWeight: '500', color: color.textPrimary },
  mono: {
    fontSize: t.typography.scale.mono.px,
    fontFamily: mono,
    fontVariant: ['tabular-nums'],
    color: color.textSecondary,
  },
});
