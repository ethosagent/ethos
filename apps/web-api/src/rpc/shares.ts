import { os } from './context';

// Thin: every refusal, the actor and the URL base are ShareService's
// (features/share/service.ts). Cookie-only — see SCOPE_MAP.shares and the
// `/rpc/shares/*` guard in routes/index.ts.
export const sharesRouter = {
  preview: os.shares.preview.handler(({ input, context }) => context.shares.preview(input)),
  create: os.shares.create.handler(({ input, context }) => context.shares.create(input)),
  list: os.shares.list.handler(({ input, context }) => context.shares.list(input)),
  revoke: os.shares.revoke.handler(({ input, context }) => context.shares.revoke(input)),
};
