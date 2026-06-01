import type { Tool } from '@ethosagent/types';
import type { WiringContext } from '@ethosagent/wiring/types';
import { createMessagingTools, type MessagingSendFn } from './index';

export interface MessagingToolsCompose {
  tools: Tool[];
}

export function compose(
  _ctx: WiringContext,
  deps: {
    send: MessagingSendFn;
    getAllowedTargets?: (personalityId?: string) => string[] | null;
  },
): MessagingToolsCompose {
  return {
    tools: createMessagingTools({
      send: deps.send,
      getAllowedTargets: deps.getAllowedTargets,
    }),
  };
}
