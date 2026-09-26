import type { Tool, WiringContext } from '@ethosagent/types';
import { createMessagingTools, type MessagingSendFn, type OutboxGate } from './index';

export interface MessagingToolsCompose {
  tools: Tool[];
}

export function compose(
  _ctx: WiringContext,
  deps: {
    send: MessagingSendFn;
    getAllowedTargets?: (personalityId?: string) => string[] | null;
    /** Approval outbox (O-T3). Omitted by every surface that wires none. */
    outbox?: OutboxGate;
  },
): MessagingToolsCompose {
  return {
    tools: createMessagingTools({
      send: deps.send,
      getAllowedTargets: deps.getAllowedTargets,
      outbox: deps.outbox,
    }),
  };
}
