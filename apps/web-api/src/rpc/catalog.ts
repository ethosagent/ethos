import { os } from './context';

// Thin RPC shell for the catalog namespace: one service call per handler.
//
// Auth posture: `catalog` is deliberately ABSENT from `SCOPE_MAP`
// (`middleware/dual-auth.ts`), so a bearer key fails closed (403 FORBIDDEN);
// pinned by `__tests__/middleware/dual-auth-catalog.test.ts`.

export const catalogRouter = {
  list: os.catalog.list.handler(({ input, context }) =>
    context.catalog.list(input.kind !== undefined ? { kind: input.kind } : {}),
  ),
  install: os.catalog.install.handler(({ input, context }) => context.catalog.install(input)),
  setSkillGrant: os.catalog.setSkillGrant.handler(({ input, context }) =>
    context.catalog.setSkillGrant(input),
  ),
};
