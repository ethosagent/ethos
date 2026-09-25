import type { PluginLoader } from '@ethosagent/plugin-loader';
import type { Logger } from '@ethosagent/types';
import type { EthosObservability } from './observability/ethos-observability';

/** What `AgentLoopConfig.credentialCheck` reports for one missing credential. */
export interface CredentialMiss {
  pluginId: string;
  credentialKey: string;
  kind: 'oauth' | 'api_key' | 'text';
  label: string;
  description?: string;
  authUrl?: string;
}

export type CredentialCheckFn = (
  sessionKey: string,
  pendingUserMessage: string,
  scope: { personalityId: string; allowedPlugins: readonly string[] },
) => Promise<CredentialMiss | null>;

export interface BuildCredentialCheckDeps {
  pluginLoader: Pick<PluginLoader, 'listManifests' | 'isLoaded' | 'getCredentialValue'>;
  observability?: Pick<EthosObservability, 'recordError'>;
  logger?: Pick<Logger, 'warn'>;
}

/**
 * Build the pre-turn `credentialCheck` (openclaw-9.5 item 1) from the plugin
 * loader. A miss is a `required: true` declaration of a LOADED plugin the
 * turn's personality may use (`scope.allowedPlugins`, the same list that gates
 * the plugin's tools and hooks) whose vault value is null. The first miss wins.
 *
 * `secret` maps to `api_key` and `text` to `text`. `oauth` is never emitted:
 * a `CredentialDeclaration` (packages/plugin-contract/src/index.ts) carries no
 * auth URL today, and an `oauth` request with nowhere to send the user would
 * be a dead end.
 *
 * Browser logins are NOT plugin credentials and are deliberately not checked
 * here. `browser_fill_credential` reads the `credentials/<name>/` vault that
 * `ethos secrets credential add` writes; a missing login there stays a refusal
 * from that tool. Folding the two together would route a website password
 * through a plugin credential prompt it was never declared for — keep them
 * separate.
 *
 * Fail-open: a vault read that throws is recorded (observability `error`
 * event, severity `warn`, code `plugin.credential_check_failed`) and that
 * declaration is skipped, so a broken vault never refuses every turn — the
 * plugin's own call then fails with its normal error. `stages/turn-setup.ts`
 * awaits this with no catch, so the catch must live here. Pinned by
 * `packages/wiring/src/__tests__/credential-check.test.ts`.
 */
export function buildCredentialCheck(deps: BuildCredentialCheckDeps): CredentialCheckFn {
  return async (_sessionKey, _pendingUserMessage, scope) => {
    if (scope.allowedPlugins.length === 0) return null;
    const allowed = new Set(scope.allowedPlugins);
    for (const manifest of deps.pluginLoader.listManifests()) {
      if (!allowed.has(manifest.id)) continue;
      if (manifest.status === 'failed' || !deps.pluginLoader.isLoaded(manifest.id)) continue;
      for (const decl of manifest.credentials) {
        if (decl.required !== true) continue;
        let value: string | null;
        try {
          value = await deps.pluginLoader.getCredentialValue(manifest.id, decl.key);
        } catch (err) {
          const cause = err instanceof Error ? err.message : String(err);
          deps.observability?.recordError({
            severity: 'warn',
            code: 'plugin.credential_check_failed',
            cause,
            details: { pluginId: manifest.id, credentialKey: decl.key },
          });
          deps.logger?.warn(
            `[wiring] credential check for plugin "${manifest.id}" key "${decl.key}" failed open: ${cause}`,
            { component: 'wiring', pluginId: manifest.id },
          );
          continue;
        }
        if (value !== null && value !== '') continue;
        return {
          pluginId: manifest.id,
          credentialKey: decl.key,
          kind: decl.type === 'secret' ? 'api_key' : 'text',
          label: decl.label,
          ...(decl.description !== undefined ? { description: decl.description } : {}),
        };
      }
    }
    return null;
  };
}
