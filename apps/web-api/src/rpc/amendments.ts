import { ORPCError } from '@orpc/server';
import { os } from './context';

// Amendments namespace — the web's READ-ONLY view of personality
// self-amendments (plan personality-memory-boundary-and-self-amendment G2, D30).
// Two reads; there is no apply, decline or rollback procedure in v1 — the
// owner acts from the TTY-gated CLI (`ethos personality amendments`).
//
// Auth: the `/rpc` cookie gate. `amendments` is not in `SCOPE_MAP`, so a
// bearer API key fails closed here (`middleware/dual-auth.ts`), pinned by
// __tests__/services/amendments.service.test.ts.

export const amendmentsRouter = {
  list: os.amendments.list.handler(({ input, context }) => context.amendments.list(input)),
  get: os.amendments.get.handler(async ({ input, context }) => {
    const found = await context.amendments.get(input.amendmentId);
    if (found) return found;
    throw new ORPCError('NOT_FOUND', {
      status: 404,
      message: `No amendment ${input.amendmentId}`,
    });
  }),
};
