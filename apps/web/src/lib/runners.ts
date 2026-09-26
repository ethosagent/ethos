import type { RunnerIdentity } from '@ethosagent/chat-state';
import type { CSSProperties } from 'react';

// The CSS half of runner identity (pi-delegation D19; DESIGN.md "Runner
// accent"). The identity map itself — `RUNNERS`, `resolveRunner`, the hex —
// is pure data shared with the phone, so it lives in `@ethosagent/chat-state`
// (packages/chat-state/src/runners.ts).

/** The accent for the active surface, or the dim text token when there is none. */
export function runnerAccentCss(runner: RunnerIdentity, light: boolean): string {
  if (!runner.accent) return 'var(--ethos-text-dim)';
  return light ? runner.accent.light : runner.accent.dark;
}

/**
 * `--runner-accent` for a subtree, as a style prop — the same shape
 * `accentVars` uses for `--accent`, and for the same reason: raw CSS needs the
 * variable stamped on a real element.
 */
export function runnerAccentVars(runner: RunnerIdentity, light: boolean): CSSProperties {
  return { '--runner-accent': runnerAccentCss(runner, light) } as CSSProperties;
}
