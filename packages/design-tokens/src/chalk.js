import { accentFor } from './index';
/**
 * Bind tokens to a chalk instance. The caller supplies their `chalk` so
 * design-tokens stays peer-dep-only on chalk (no version pinning here).
 */
export function tokensToChalk(chalk, tokens, personalityId) {
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
