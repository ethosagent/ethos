import { accentFor, type Tokens } from './index';

// Minimal structural type matching the part of `chalk` we use. Defined
// locally so the package doesn't need a chalk type dep — the consumer
// passes their own chalk instance and the runtime shape is what matters.
// Each chalk modifier is callable as a tag/template producing strings.
export type ChalkInstance = {
  (input: string): string;
  hex: (hex: string) => ChalkInstance;
};

// CLI surface adapter — returns helpers pre-bound to the personality
// accent + surface colors. Consumers import { tokensToChalk } from
// '@ethosagent/design-tokens/chalk' so terminals that don't have a chalk
// peer dep don't pay for it.
//
// `chalk.hex()` covers truecolor (24-bit) terminals; chalk falls back
// internally for ANSI-256/16 terminals — we don't need to mirror the
// DESIGN.md "Cross-surface token mapping" ANSI codes here. If a future
// non-truecolor target emerges, the mapping table on lines 162-169 of
// DESIGN.md is the source.

export interface TokensChalk {
  /** Personality accent — for tagged log lines, prompt indicator, separators. */
  accent: ChalkInstance;
  /** Surface text-secondary — dim secondary text, status lines. */
  dim: ChalkInstance;
  /** Surface text-tertiary — even more muted (captions, section labels). */
  muted: ChalkInstance;
  /** Semantic success (matches engineer green). */
  success: ChalkInstance;
  /** Semantic warning (matches reviewer amber). */
  warning: ChalkInstance;
  /** Semantic error (distinct red, never a personality color). */
  error: ChalkInstance;
  /** Semantic info (matches researcher blue). */
  info: ChalkInstance;
  /** Glyph palette — shared with TUI for visual cohesion. */
  glyphs: Tokens['glyphs'];
}

/**
 * Bind tokens to a chalk instance. The caller supplies their `chalk` so
 * design-tokens stays peer-dep-only on chalk (no version pinning here).
 */
export function tokensToChalk(
  chalk: ChalkInstance,
  tokens: Tokens,
  personalityId: string,
): TokensChalk {
  return {
    accent: chalk.hex(accentFor(tokens, personalityId)),
    dim: chalk.hex(tokens.surface.textSecondary),
    muted: chalk.hex(tokens.surface.textTertiary),
    success: chalk.hex(tokens.semantic.success),
    warning: chalk.hex(tokens.semantic.warning),
    error: chalk.hex(tokens.semantic.error),
    info: chalk.hex(tokens.semantic.info),
    glyphs: tokens.glyphs,
  };
}
