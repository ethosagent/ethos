import type { EthosPlugin } from '@ethosagent/plugin-sdk';
import type { TrustTier } from '@ethosagent/safety-scanner';

/**
 * The seam between the loader and a plugin-host runtime (plan
 * plugin-process-isolation §5.4.2, D8). Types only: `@ethosagent/plugin-host`
 * implements it and the composition root injects it, so plugin-loader never
 * imports plugin-host.
 */
export interface PluginActivationRequest {
  id: string;
  /** Absolute plugin directory. */
  dir: string;
  /** Resolved entry module the loader would otherwise `import()`. */
  entry: string;
  /** The plugin's parsed package.json (opaque to the loader). */
  manifest: Record<string, unknown>;
  tier: TrustTier;
}

export interface PluginActivator {
  /**
   * Returns a synthetic `EthosPlugin`. Its `activate(api)` replays the
   * out-of-process registrations onto the parent's real `PluginApiImpl` as
   * proxies; its `deactivate()` releases the lease. Rejects when the host
   * cannot start or the plugin fails to activate there.
   */
  activate(request: PluginActivationRequest): Promise<EthosPlugin>;
}
