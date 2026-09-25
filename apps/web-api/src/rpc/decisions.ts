import { os } from './context';

// Decisions namespace — Settings › Models › decision models
// (plan/phases/decision-provider-jev.md §7, §12). Every handler is one
// `DecisionsService` call.
//
// Auth posture: deliberately ABSENT from `dual-auth.ts`'s `SCOPE_MAP`, like
// `modelRegistry` and `namedSecrets`. These handlers write a vault credential
// and spend the operator's provider credit, so with no entry `dualAuth`
// refuses the whole namespace to a Bearer caller before a handler runs.

/**
 * The rate-limit bucket this caller shares — the same `_authMethod` read as
 * `rpc/model-registry.ts`, the only caller distinction a handler can make
 * here. Absent means cookie.
 */
function callerOf(context: unknown): string {
  return (context as { _authMethod?: unknown })._authMethod === 'bearer' ? 'bearer' : 'cookie';
}

export const decisionsRouter = {
  list: os.decisions.list.handler(({ context }) => context.decisions.list()),
  setKey: os.decisions.setKey.handler(({ input, context }) => context.decisions.setKey(input)),
  clearKey: os.decisions.clearKey.handler(({ input, context }) =>
    context.decisions.clearKey(input),
  ),
  test: os.decisions.test.handler(({ input, context }) =>
    context.decisions.test(input, callerOf(context)),
  ),
};
