// Who runs where (plan plugin-process-isolation §6.2, D24). Pure: the loader
// seam supplies the facts, this decides the mode.

export type PluginIsolationModeName = 'in-process' | 'host';

/** Structural subset of `PluginIsolationConfig` (@ethosagent/config) this policy reads. */
export interface IsolationPolicyConfig {
  default: PluginIsolationModeName;
  overrides: Record<string, PluginIsolationModeName>;
}

export interface ResolvePluginIsolationInput {
  pluginId: string;
  packageName: string;
  /** Where the code was loaded from. Only `node_modules` can be first-party. */
  installLocation: 'node_modules' | 'plugins-dir' | 'local-dir' | 'workspace';
  /** `PluginGrant.catalogTier`, when the grant records one. */
  catalogTier?: string;
  /** Absent config means the default: in-process. */
  config?: IsolationPolicyConfig;
}

export interface PluginIsolationDecision {
  mode: PluginIsolationModeName;
  /** Set when a configured value was refused or ignored. */
  notice?: string;
}

export function resolvePluginIsolation(
  input: ResolvePluginIsolationInput,
): PluginIsolationDecision {
  const { pluginId, packageName, installLocation, catalogTier, config } = input;
  const override = config?.overrides[pluginId];

  // First-party: scope plus install location. `~/.ethos/plugins/` is writable by
  // anyone, so a directory named @ethosagent/* there is not first-party.
  if (packageName.startsWith('@ethosagent/') && installLocation === 'node_modules') {
    return { mode: 'in-process' };
  }

  if (catalogTier === 'community') {
    if (override === 'in-process') {
      return {
        mode: 'host',
        notice: `plugins.isolation.${pluginId}: in-process is refused for a catalog community plugin; it runs in the plugin host. Install it outside the catalog to run it in-process.`,
      };
    }
    return { mode: 'host' };
  }

  return { mode: override ?? config?.default ?? 'in-process' };
}
