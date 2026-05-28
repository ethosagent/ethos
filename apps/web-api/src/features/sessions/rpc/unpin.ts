import { os } from '../../../rpc/context';

export const sessionsUnpin = os.sessions.unpin.handler(({ input, context }) =>
  context.sessions.unpin(input.id),
);
