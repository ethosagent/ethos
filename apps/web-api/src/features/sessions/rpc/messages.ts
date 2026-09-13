import { os } from '../../../rpc/context';

export const sessionsMessages = os.sessions.messages.handler(({ input, context }) =>
  context.sessions.messages({
    id: input.id,
    turns: input.turns,
    ...(input.before !== undefined ? { before: input.before } : {}),
  }),
);
