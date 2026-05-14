import { accentFor, DEFAULT_TOKENS } from '@ethosagent/design-tokens';
import type { ThemeConfig } from 'antd';

// Chat-tab theming. The user's pinned skin from `~/.ethos/config.yaml` is
// carried by the OUTER ConfigProvider in main.tsx; this inner provider only
// swaps the accent colour, which still varies per personality. Per-personality
// skin overrides were removed in the personality-alignment phase — a
// personality is an identity, not a theme.

export function personalityTheme(personalityId: string): ThemeConfig {
  // Per-personality accent override. Whatever the outer provider resolved
  // (engine default or user-pinned skin), the chat subtree keeps that base
  // and only re-tints the accent for this personality.
  return { token: { colorPrimary: accentFor(DEFAULT_TOKENS, personalityId) } };
}
