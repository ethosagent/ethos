import type { ToolContext } from '@ethosagent/types';

/**
 * The turn's `ToolContext.toolsetNarrowing` (S12, plan openclaw-2026.9.6-gaps):
 * its effective allowlist and surface exclusion, or `undefined` when it has
 * neither. Spread into every tool's context by `processTools`
 * (`./stages/tool-processing.ts`); pinned by
 * `./__tests__/tool-narrowing-context.test.ts`.
 */
export function toolsetNarrowingOf(
  allowedTools: string[] | undefined,
  excludeTools: string[] | undefined,
): Pick<ToolContext, 'toolsetNarrowing'> {
  if (!allowedTools && !excludeTools) return {};
  return {
    toolsetNarrowing: {
      ...(allowedTools ? { narrow: allowedTools } : {}),
      ...(excludeTools ? { exclude: excludeTools } : {}),
    },
  };
}
