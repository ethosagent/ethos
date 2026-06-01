import { os } from '../../../rpc/context';

export const sessionsDelete = os.sessions.delete.handler(async ({ input, context }) => {
  await context.sessions.delete(input.id);
  return { ok: true as const };
});
