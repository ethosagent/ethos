import type { PluginActivationRequest, PluginActivator } from '@ethosagent/plugin-loader';
import type { EthosPlugin } from '@ethosagent/plugin-sdk';
import type { SimpleCompletion, ToolRegistry } from '@ethosagent/types';
import type { PluginHostPool } from './pool';
import { assertToolNameFree, replayRegistration } from './proxies/replay';

export type { PluginActivationRequest, PluginActivator };

export interface PluginActivatorOptions {
  /** Base URL handed to the hosted plugin (`api.getBaseUrl()`); the first loop's wins (plan §13.12). */
  baseUrl?: string;
  /** Key NAMES under `plugins/<id>/`, for the child's synchronous `hasSecret` (D19). */
  secretKeys?: (pluginId: string) => string[] | Promise<string[]>;
  /** The loop's `registries.llmFactory`, read lazily, for monitor `ctx.llm` (it is assigned after load). */
  llmFactory?: () => SimpleCompletion | undefined;
  /**
   * The loop's tool registry. A hosted tool named like one already there (a
   * built-in such as `read_file`, or another plugin's tool) refuses the whole
   * plugin load, because `DefaultToolRegistry.register` silently overwrites.
   */
  tools?: Pick<ToolRegistry, 'get' | 'getPluginId'>;
  /**
   * The plugin's `plugins.lock` integrity, when it is lock-pinned. It keys the
   * registration cache (§5.4.3); without it the cache keys on the entry mtime.
   */
  integrity?: (pluginId: string) => string | undefined | Promise<string | undefined>;
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
      const integrity = await safeIntegrity(opts.integrity, req.id);
      const version = typeof req.manifest.version === 'string' ? req.manifest.version : undefined;
      const lease = await pool.acquire({
        id: req.id,
        dir: req.dir,
        entry: req.entry,
        tier: req.tier,
        ...(version ? { version } : {}),
        ...(integrity ? { integrity } : {}),
        ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
        secretKeys,
        ...(req.network !== undefined ? { network: req.network } : {}),
      });
      let unsubscribe: (() => void) | undefined;
      return {
        activate(api) {
          lease.bindApi(api, opts.llmFactory);
          const guard = { ...(opts.tools ? { tools: opts.tools } : {}) };
          // Check every tool before the first replay, so a refusal leaves nothing registered.
          for (const reg of lease.registrations) assertToolNameFree(reg, lease, guard);
          for (const reg of lease.registrations) replayRegistration(api, reg, lease, guard);
          unsubscribe = lease.onRegistrationAdded((reg) =>
            replayRegistration(api, reg, lease, guard),
          );
        },
        deactivate() {
          unsubscribe?.();
          lease.release();
        },
      };
    },
  };
}

async function safeIntegrity(
  get: PluginActivatorOptions['integrity'],
  pluginId: string,
): Promise<string | undefined> {
  try {
    return (await get?.(pluginId)) || undefined;
  } catch {
    return undefined; // an unreadable lockfile only costs the cache its stronger key
  }
}
