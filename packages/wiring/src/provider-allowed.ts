/**
 * §4.B trust gate — default-deny for plugin-contributed LLM providers.
 * Built-in providers (no `/` in name) are always allowed.
 * Plugin providers (`pluginId/name`) require `pluginId` in the allowlist.
 * When `allowedPlugins` is undefined, all providers are allowed (backward compat).
 */
export function isProviderAllowed(providerName: string, allowedPlugins?: string[]): boolean {
  if (!allowedPlugins) return true;
  if (!providerName.includes('/')) return true;
  const pluginId = providerName.split('/')[0] ?? '';
  return allowedPlugins.includes(pluginId);
}
