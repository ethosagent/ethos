import { pluginCredentialPrefix, pluginCredentialRef } from '@ethosagent/plugin-sdk';
import type { SecretRefAuthorizer } from './capability-server';

/**
 * Decides whether a hosted plugin may touch a secret ref (plan §5.5, D19).
 * Allowed only inside `plugins/<id>/`: the ref must start with
 * `pluginCredentialPrefix(id)` and, for get/set/capability, round-trip through
 * `pluginCredentialRef` (which refuses traversal-shaped keys). A `list` names a
 * prefix, not a key, so only the prefix test applies.
 *
 * This function only answers yes or no. The refusal (`PLUGIN_HOST_SECRET_DENIED`
 * plus a `plugin_host.denied {plugin_id, kind: 'secret', ref}` event, never the
 * value) is raised by its two callers, `keyOf` in parent-handlers.ts and
 * `ethos/capability.secret` in capability-server.ts; both are pinned by
 * `__tests__/isolation-boundary.test.ts`. The read itself goes through the
 * parent's own `PluginApiImpl.getSecret` (parent-handlers.ts), so the existing
 * scoping code in plugin-sdk is the second enforcer.
 */
export const authorizeSecretRef: SecretRefAuthorizer = (pluginId, ref, op) => {
  try {
    const prefix = pluginCredentialPrefix(pluginId);
    if (!ref.startsWith(prefix)) return false;
    if (op === 'list') return true;
    return pluginCredentialRef(pluginId, ref.slice(prefix.length)) === ref;
  } catch {
    return false;
  }
};
