import { accentFor, BUILTIN_SKINS, DEFAULT_TOKENS, resolveSkin } from '@ethosagent/design-tokens';
import { tokensToAntd } from '@ethosagent/design-tokens/antd';
import type { ThemeConfig } from 'antd';

// Per-personality chat-tab theming. Phase 3 resolution order — highest wins:
//   1. User pin (config.yaml `skin:`) — applied by the OUTER ConfigProvider
//      in main.tsx. When set, the inner provider only swaps the accent.
//   2. Personality default (personality.skin) — when no user pin, the chat
//      tab applies the personality's full token slice (so paper/mono change
//      surface colors too, not just the accent).
//   3. Engine default — no override; inner provider just swaps the accent.

export interface PersonalityThemeOptions {
  /** The user's pinned skin from `~/.ethos/config.yaml`. When `null` or
   *  `'default'`, the personality's own skin (if any) wins. */
  userPin?: string | null;
  /** The personality's declared `skin` field. */
  personalitySkin?: string | null;
}

export function personalityTheme(
  personalityId: string,
  options: PersonalityThemeOptions = {},
): ThemeConfig {
  const accent = accentFor(DEFAULT_TOKENS, personalityId);
  const { userPin, personalitySkin } = options;

  // User pin wins. Outer provider already carries the pinned tokens; just
  // override the accent for this chat subtree.
  const userPinActive = !!(userPin && userPin !== 'default' && BUILTIN_SKINS[userPin]);
  if (userPinActive) {
    return { token: { colorPrimary: accent } };
  }

  // No user pin, personality declares a skin → apply its full token slice
  // to the chat tab. Outer provider stays on the base theme so non-chat
  // surfaces (sidebar, top bar) keep their look.
  if (personalitySkin && BUILTIN_SKINS[personalitySkin]) {
    try {
      const personalityTokens = resolveSkin(DEFAULT_TOKENS, BUILTIN_SKINS, personalitySkin);
      const antdConfig = tokensToAntd(personalityTokens);
      return {
        ...antdConfig,
        token: { ...antdConfig.token, colorPrimary: accent },
      };
    } catch {
      // Unknown skin name → fall through to the accent-only override.
    }
  }

  return { token: { colorPrimary: accent } };
}
