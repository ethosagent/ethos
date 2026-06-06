import { os } from '../../../rpc/context';

export const debugChat = os.debug.chat.handler(({ input, context }) =>
  context.debug.chat({
    mainSessionId: input.mainSessionId,
    message: input.message,
    ...(input.clientId ? { clientId: input.clientId } : {}),
  }),
);
