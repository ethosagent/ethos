import { accentFor, type Tokens } from './index';

// VS Code webview adapter. The extension keeps host chrome on the user's
// active VS Code theme (`--vscode-*` variables) so the editor stays
// consistent. Only personality-specific affordances — chat header stripe,
// tool chip icon, focus ring — get our accents. The CSS variable block
// returned here is injected into the webview's root.

export function tokensToVscode(tokens: Tokens, personalityId: string): string {
  const accent = accentFor(tokens, personalityId);
  return `:root {
  --ethos-accent: ${accent};
  --ethos-bg-elevated: ${tokens.surface.bgElevated};
  --ethos-bg-overlay: ${tokens.surface.bgOverlay};
  --ethos-border-subtle: ${tokens.surface.borderSubtle};
  --ethos-border-strong: ${tokens.surface.borderStrong};
  --ethos-text-secondary: ${tokens.surface.textSecondary};
  --ethos-text-tertiary: ${tokens.surface.textTertiary};
  --ethos-success: ${tokens.semantic.success};
  --ethos-warning: ${tokens.semantic.warning};
  --ethos-error: ${tokens.semantic.error};
  --ethos-info: ${tokens.semantic.info};
  --ethos-motion-fast: ${tokens.motion.fastMs}ms;
  --ethos-motion-default: ${tokens.motion.defaultMs}ms;
  --ethos-motion-slow: ${tokens.motion.slowMs}ms;
  --ethos-motion-ease: ${tokens.motion.ease};
  --ethos-radius-sm: ${tokens.radius.sm}px;
  --ethos-radius-md: ${tokens.radius.md}px;
  --ethos-radius-lg: ${tokens.radius.lg}px;
}`;
}
