import type { Tool } from '@ethosagent/types';
import type { WatcherManager } from '@ethosagent/watchers';
import type { WiringContext } from '@ethosagent/wiring/types';
import { createWatcherTools, type WatcherOutboxGate } from './index';

export interface WatcherToolsCompose {
  tools: Tool[];
}

export function compose(
  _ctx: WiringContext,
  deps: {
    manager: WatcherManager;
    /** Approval outbox (O-T12). Omitted by every surface that wires none. */
    outbox?: WatcherOutboxGate;
  },
): WatcherToolsCompose {
  return { tools: createWatcherTools(deps.manager, { outbox: deps.outbox }) };
}
