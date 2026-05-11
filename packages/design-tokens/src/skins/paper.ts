import type { Skin } from './index';

// Light-mode surface from the DESIGN.md "Surface tokens" table. Personality
// accents stay the same (DESIGN.md hex values work on both light and dark
// per the contrast spec) — only the surface layer flips. The name reflects
// the warm-off-white feel: paper-warm, not pure white.
export const paperSkin: Skin = {
  name: 'paper',
  description: 'Light mode — paper-warm surfaces, full per-personality accents.',
  tokens: {
    surface: {
      bgBase: '#FAFAF7',
      bgElevated: '#FFFFFF',
      bgOverlay: '#F0F0EC',
      borderSubtle: '#E8E8E4',
      borderStrong: '#D0D0CC',
      textPrimary: '#1A1A1A',
      textSecondary: '#6B6B6A',
      textTertiary: '#94948F',
    },
  },
};
