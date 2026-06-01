import type { WiringContext } from '@ethosagent/wiring/types';
import { MarkdownFileMemoryProvider } from './index';

export interface MemoryMarkdownCompose {
  memoryProvider: MarkdownFileMemoryProvider;
}

export function compose(ctx: WiringContext): MemoryMarkdownCompose {
  return {
    memoryProvider: new MarkdownFileMemoryProvider({ dir: ctx.dataDir }),
  };
}
