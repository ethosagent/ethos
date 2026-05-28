import { os } from '../../../rpc/context';

export const sessionsUpdate = os.sessions.update.handler(({ input, context }) =>
  context.sessions.update(input.id, { title: input.title }),
);
