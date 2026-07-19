import type { Tool } from '@ethosagent/types';
import type { WatcherManager } from '@ethosagent/watchers';
import type { WiringContext } from '@ethosagent/wiring/types';
import { createWatcherTools } from './index';

export interface WatcherToolsCompose {
  tools: Tool[];
}

export function compose(
  _ctx: WiringContext,
  deps: { manager: WatcherManager },
): WatcherToolsCompose {
  return { tools: createWatcherTools(deps.manager) };
}
