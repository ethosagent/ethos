import type { PluginActivationRequest, PluginActivator } from '@ethosagent/plugin-loader';
import type { EthosPlugin } from '@ethosagent/plugin-sdk';
import type { PluginHostPool } from './pool';
import { replayRegistration } from './proxies/replay';

export type { PluginActivationRequest, PluginActivator };

export interface PluginActivatorOptions {
  /** Base URL handed to the hosted plugin (`api.getBaseUrl()`); the first loop's wins (plan §13.12). */
  baseUrl?: string;
  /** Key NAMES under `plugins/<id>/`, for the child's synchronous `hasSecret` (D19). */
  secretKeys?: (pluginId: string) => string[] | Promise<string[]>;
}

/**
 * The `PluginActivator` the loader calls instead of `import()` for a hosted
 * plugin. It leases the plugin's host and returns a synthetic `EthosPlugin`:
 * `activate(api)` replays the host's registrations as proxies on the parent's
 * own `PluginApiImpl`; `deactivate()` releases the lease.
 */
export function createPluginActivator(
  pool: PluginHostPool,
  opts: PluginActivatorOptions = {},
): PluginActivator {
  return {
    async activate(req: PluginActivationRequest): Promise<EthosPlugin> {
      const secretKeys = (await opts.secretKeys?.(req.id)) ?? [];
      const lease = await pool.acquire({
        id: req.id,
        dir: req.dir,
        entry: req.entry,
        tier: req.tier,
        ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
        secretKeys,
      });
      let unsubscribe: (() => void) | undefined;
      return {
        activate(api) {
          lease.bindApi(api);
          for (const reg of lease.registrations) replayRegistration(api, reg, lease);
          unsubscribe = lease.onRegistrationAdded((reg) => replayRegistration(api, reg, lease));
        },
        deactivate() {
          unsubscribe?.();
          lease.release();
        },
      };
    },
  };
}
