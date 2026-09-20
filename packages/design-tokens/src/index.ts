// DESIGN.md tokens as runtime data. Surfaces (TUI, Web, CLI, ...) import
// from here; DESIGN.md remains the canonical written reference. Drift
// between this file and DESIGN.md is caught by the parity test in
// __tests__/design-md-parity.test.ts.
//
// This file is a pure barrel — the concrete token contract and derived-
// accent logic live in `./tokens` so `./skins` and `./validate` can import
// them without importing this barrel back (that round trip was a real
// require cycle: this file re-exports skins/validate, and both of them
// pulled DEFAULT_TOKENS/Tokens from '../index'/'./index'). Import from
// `./tokens` directly if you're inside this package; consumers keep using
// `@ethosagent/design-tokens`, unaffected by the split.

// Re-exports so consumers can `import { resolveSkin } from '@ethosagent/design-tokens'`
// instead of reaching into sub-paths. Sub-path imports also work for tree-shaking.
export {
  BUILTIN_SKIN_NAMES,
  BUILTIN_SKINS,
  type DeepPartial,
  defaultSkin,
  monoSkin,
  paperSkin,
  resolveBuiltinSkin,
  resolveSkin,
  type Skin,
  type SkinRegistry,
} from './skins';
export type {
  SpacingKey,
  Tokens,
  TypographyRole,
  TypographyScaleEntry,
} from './tokens';
export {
  accentFor,
  BUILTIN_PERSONALITY_IDS,
  DEFAULT_TOKENS,
  isBuiltinPersonality,
  personalityAccent,
} from './tokens';
export {
  contrastRatio,
  hexToHue,
  type ValidationFinding,
  type ValidationResult,
  validateSkin,
  validateTokens,
} from './validate';
