import {
  accentFor,
  BUILTIN_SKIN_NAMES,
  BUILTIN_SKINS,
  DEFAULT_TOKENS,
  personalityAccent as resolvePersonalityAccent,
  resolveSkin,
  type Skin,
  type SkinRegistry,
  type Tokens,
} from '@ethosagent/design-tokens';
import { createContext, useContext } from 'react';

// TUI skin adapter. Two consumption modes:
//
//   1. Chat-UI components — read live tokens via `useSkin()`. These react
//      to `/skin <name>` swaps without restart.
//   2. Setup wizard (apps/tui/src/setup/) — reads `DESIGN`/`GLYPHS` static
//      views. The wizard runs before SkinContext is set up and never
//      participates in skin switching (no skin command pre-setup).
//
// `DESIGN`/`GLYPHS` are derived from `DEFAULT_TOKENS` so a single hex
// change in design-tokens flows to both call-site styles.

export const tokens: Tokens = DEFAULT_TOKENS;

/** DESIGN.md canonical color tokens — derived from DEFAULT_TOKENS. */
export const DESIGN = {
  textPrimary: tokens.surface.textPrimary,
  textSecondary: tokens.surface.textSecondary,
  textTertiary: tokens.surface.textTertiary,
  bgBase: tokens.surface.bgBase,
  bgElevated: tokens.surface.bgElevated,
  borderSubtle: tokens.surface.borderSubtle,
  borderStrong: tokens.surface.borderStrong,
  success: tokens.semantic.success,
  warning: tokens.semantic.warning,
  error: tokens.semantic.error,
  info: tokens.semantic.info,
} as const;

/** Unified glyph palette — DEFAULT_TOKENS.glyphs. */
export const GLYPHS = tokens.glyphs;

export function personalityAccent(personality: string): string {
  return resolvePersonalityAccent(personality);
}

export type { Skin, SkinRegistry, Tokens };
export { accentFor, BUILTIN_SKIN_NAMES, BUILTIN_SKINS, resolveSkin };

export const SkinContext = createContext<Tokens>(DEFAULT_TOKENS);

/** Returns the current resolved tokens from `SkinContext`. */
export function useSkin(): Tokens {
  return useContext(SkinContext);
}
