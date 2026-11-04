import { pluginCredentialPrefix } from '@ethosagent/plugin-sdk';
import type { ToolCapabilities } from '@ethosagent/types';
import type { HostEventSink } from './events';

function ownPrefix(pluginId: string): string | null {
  try {
    return pluginCredentialPrefix(pluginId);
  } catch {
    return null;
  }
}

/**
 * Clamps a hosted tool's DECLARED capabilities at replay (plan §5.5, D20).
 *
 * - `secrets` keeps only refs inside `plugins/<id>/`; each dropped ref is
 *   reported in a `plugin_host.capability_clamped` event.
 * - `process` is removed from the proxy: the parent's `resolveCapabilities`
 *   would otherwise build a `ScopedProcessImpl` that spawns outside the host's
 *   env and sandbox. The host builds its own `ScopedProcessImpl` from the
 *   registration's declared `allowedBinaries` (`child/context.ts`).
 *
 * Pinned by `__tests__/proxies.test.ts` (unit) and
 * `__tests__/isolation-boundary.test.ts` (end to end, the secretsResolver
 * refuses `providers/anthropic/apiKey`).
 */
export function clampToolCapabilities(
  caps: ToolCapabilities,
  pluginId: string,
  toolName: string,
  emit: HostEventSink,
): ToolCapabilities {
  const { process: declaredProcess, ...rest } = caps;
  let out: ToolCapabilities = rest;
  if (rest.secrets) {
    const prefix = ownPrefix(pluginId);
    const kept = rest.secrets.filter((ref) => prefix !== null && ref.startsWith(prefix));
    const dropped = rest.secrets.filter((ref) => !kept.includes(ref));
    if (dropped.length > 0) {
      emit('plugin_host.capability_clamped', {
        plugin_id: pluginId,
        tool: toolName,
        capability: 'secrets',
        dropped,
      });
    }
    out = { ...rest, secrets: kept };
  }
  if (declaredProcess) {
    emit('plugin_host.capability_clamped', {
      plugin_id: pluginId,
      tool: toolName,
      capability: 'process',
      dropped: ['process'],
    });
  }
  return out;
}
