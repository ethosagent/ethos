import { os } from '../../../rpc/context';

export const chatAbort = os.chat.abort.handler(async ({ input, context }) => {
  await context.chat.abort(input.sessionId);
  return { ok: true as const };
});
