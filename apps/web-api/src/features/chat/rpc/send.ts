import { os } from '../../../rpc/context';

export const chatSend = os.chat.send.handler(({ input, context }) =>
  context.chat.send({
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    clientId: input.clientId,
    text: input.text,
    ...(input.personalityId ? { personalityId: input.personalityId } : {}),
    ...(input.dryRun ? { dryRun: true } : {}),
  }),
);
