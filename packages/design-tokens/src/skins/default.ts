import type { Skin } from './index';

// The empty skin — surface and accent tokens come straight from
// DEFAULT_TOKENS. Lives as its own module so users can `extends: 'default'`
// without the engine special-casing the name.
export const defaultSkin: Skin = {
  name: 'default',
  description: 'DESIGN.md baseline — dark mode, full per-personality accents.',
  tokens: {},
};
