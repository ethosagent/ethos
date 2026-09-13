import { os } from './context';

// The model registry's on-demand test (T1.24). `test` is the namespace's only
// member until T2.2 adds list/upsert/remove/setDefault/setRole.

/**
 * The rate-limit bucket this caller shares, alongside the alias.
 *
 * Same `_authMethod` read as `rpc/cron.ts` and `rpc/backup.ts` — it is the only
 * caller distinction a handler can make here, so bearer callers and cookie
 * callers get one bucket each. Absent means cookie.
 */
function callerOf(context: unknown): string {
  return (context as { _authMethod?: unknown })._authMethod === 'bearer' ? 'bearer' : 'cookie';
}

export const modelRegistryRouter = {
  test: os.modelRegistry.test.handler(({ input, context }) =>
    context.modelRegistry.test(input, callerOf(context)),
  ),
};
