import type { WiringContext } from '@ethosagent/types';
import { MarkdownFileMemoryProvider, type MemoryCharLimits } from './index';

export interface MemoryMarkdownCompose {
  memoryProvider: MarkdownFileMemoryProvider;
}

export function compose(
  ctx: WiringContext,
  opts?: { charLimits?: MemoryCharLimits },
): MemoryMarkdownCompose {
  return {
    memoryProvider: new MarkdownFileMemoryProvider({
      dir: ctx.dataDir,
      storage: ctx.storage,
      ...(opts?.charLimits ? { charLimits: opts.charLimits } : {}),
    }),
  };
}
