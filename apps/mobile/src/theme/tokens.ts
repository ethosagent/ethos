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
