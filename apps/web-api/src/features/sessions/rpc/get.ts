import { os } from '../../../rpc/context';

export const sessionsGet = os.sessions.get.handler(({ input, context }) =>
  context.sessions.get(input.id),
);
