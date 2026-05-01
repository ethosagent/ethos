import { createContext, useContext } from 'react';

// DESIGN.md canonical hex values — use these, never Ink color names.
export const DESIGN = {
  textPrimary: '#E8E8E6',
  textSecondary: '#9A9A98',
  textTertiary: '#6B6B6A',
  bgBase: '#0F0F0F',
  bgElevated: '#1A1A1A',
  borderSubtle: '#2A2A2A',
  borderStrong: '#3A3A3A',
  success: '#4ADE80',
  warning: '#F59E0B',
  error: '#F87171',
  info: '#4A9EFF',
} as const;

const PERSONALITY_ACCENTS: Record<string, string> = {
  researcher: '#4A9EFF',
  engineer: '#4ADE80',
  reviewer: '#F59E0B',
  coach: '#E879F9',
  operator: '#94A3B8',
};

export function personalityAccent(personality: string): string {
  return PERSONALITY_ACCENTS[personality] ?? '#4A9EFF';
}

// Unified glyph palette — one glyph per role, never improvised.
export const GLYPHS = {
  prompt: '›',
  accentStripe: '▌',
  toolStart: '⟢',
  toolOk: '✓',
  toolFail: '✗',
  divider: '─',
  barFill: '▓',
  barEmpty: '░',
} as const;

export interface SkinConfig {
  name: string;
  bannerColor: string;
  modelColor: string;
  userColor: string;
  assistantColor: string;
  promptGlyph: string;
  promptColor: string;
  borderStyle: 'single' | 'double' | 'round' | 'bold' | 'classic' | 'singleDouble';
  thinkingColor: string;
  toolPrefix: string;
}

// Single canonical skin — dark-mode primary per DESIGN.md.
// The `minimal` constant below is applied as overrides via /skin minimal.
const BASE_SKIN: SkinConfig = {
  name: 'default',
  bannerColor: DESIGN.textPrimary,
  modelColor: DESIGN.textSecondary,
  userColor: DESIGN.info,
  assistantColor: DESIGN.success,
  promptGlyph: GLYPHS.prompt,
  promptColor: DESIGN.info,
  borderStyle: 'single',
  thinkingColor: '#E879F9',
  toolPrefix: GLYPHS.toolStart,
};

export const MINIMAL_OVERRIDES: Partial<SkinConfig> = {
  name: 'minimal',
  bannerColor: DESIGN.textPrimary,
  modelColor: DESIGN.textTertiary,
  userColor: DESIGN.textSecondary,
  assistantColor: DESIGN.textPrimary,
  promptGlyph: GLYPHS.prompt,
  promptColor: DESIGN.textSecondary,
  thinkingColor: DESIGN.textTertiary,
  toolPrefix: GLYPHS.toolStart,
};

export const SKINS: Record<string, SkinConfig> = {
  default: BASE_SKIN,
  minimal: { ...BASE_SKIN, ...MINIMAL_OVERRIDES },
};

export const DEFAULT_SKIN = SKINS.default;

export const SkinContext = createContext<SkinConfig>(DEFAULT_SKIN);

export function useSkin(): SkinConfig {
  return useContext(SkinContext);
}
