import { os } from '../../../rpc/context';

export const sessionsRewind = os.sessions.rewind.handler(({ input, context }) =>
  context.sessions.rewind(
    input.id,
    input.messageId !== undefined
      ? { messageId: input.messageId }
      : { turnsBack: input.turnsBack ?? 1 },
  ),
);
