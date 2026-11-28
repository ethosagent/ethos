import { ORPCError } from '@orpc/server';
import { os } from './context';

// Initiative engine namespaces. Owner cookie + CSRF only: neither `initiatives` nor `constitution`
// is a SCOPE_MAP namespace, so bearer API keys get 403 (middleware/dual-auth.ts), pinned by
// __tests__/routes/initiatives-rpc.test.ts. All logic lives in InitiativesService.

export const initiativesRouter = {
  list: os.initiatives.list.handler(({ input, context }) => context.initiatives.list(input)),
  get: os.initiatives.get.handler(({ input, context }) => context.initiatives.get(input.id)),
  activity: os.initiatives.activity.handler(({ input, context }) =>
    context.initiatives.activity(input),
  ),
  exploringNow: os.initiatives.exploringNow.handler(({ input, context }) =>
    context.initiatives.exploringNow(input),
  ),
  metrics: os.initiatives.metrics.handler(({ input, context }) =>
    context.initiatives.metrics(input),
  ),
  decide: os.initiatives.decide.handler(async ({ input, context }) => {
    const r = await context.initiatives.decide(input);
    if (r.ok) return r;
    if (r.kind === 'not_found')
      throw new ORPCError('NOT_FOUND', { status: 404, message: r.message });
    if (r.kind === 'conflict') throw new ORPCError('CONFLICT', { status: 409, message: r.message });
    throw new ORPCError('BAD_REQUEST', { status: 400, message: r.message });
  }),
  settings: os.initiatives.settings.handler(({ input, context }) =>
    context.initiatives.settings(input.personalityId),
  ),
  settingsSave: os.initiatives.settingsSave.handler(({ input, context }) =>
    context.initiatives.settingsSave(input),
  ),
};

export const constitutionRouter = {
  initiatives: os.constitution.initiatives.handler(({ context }) =>
    context.initiatives.constitution(),
  ),
  initiativesSave: os.constitution.initiativesSave.handler(({ input, context }) =>
    context.initiatives.constitutionSave(input),
  ),
};
