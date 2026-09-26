import { os } from './context';

// Stored logins for `browser_fill_credential`. Values are write-only — `list`
// returns masked previews and presence flags; `set` echoes nothing back.

export const credentialsRouter = {
  list: os.credentials.list.handler(({ context }) => context.credentials.list()),

  set: os.credentials.set.handler(({ input, context }) => context.credentials.set(input)),

  delete: os.credentials.delete.handler(({ input, context }) => context.credentials.delete(input)),
};
