import { pluginCredentialPrefix } from '@ethosagent/plugin-sdk';
import type { Tool, ToolCapabilities } from '@ethosagent/types';
import type { HostLease } from '../pool';
import type { ToolRegistration } from '../protocol';
import { requestFromContext } from './request';

function ownPrefix(pluginId: string): string | null {
  try {
    return pluginCredentialPrefix(pluginId);
  } catch {
    return null;
  }
}

/**
 * Keeps only secret refs inside `plugins/<id>/`; everything else is dropped and
 * reported (D20). The full clamp policy is lane C's `capabilities.ts`.
 */
function clampSecrets(
  caps: ToolCapabilities,
  lease: HostLease,
  toolName: string,
): ToolCapabilities {
  if (!caps.secrets) return caps;
  const prefix = ownPrefix(lease.pluginId);
  const kept = caps.secrets.filter((ref) => prefix !== null && ref.startsWith(prefix));
  const dropped = caps.secrets.filter((ref) => !kept.includes(ref));
  if (dropped.length > 0) {
    lease.emitEvent('plugin_host.capability_clamped', {
      plugin_id: lease.pluginId,
      tool: toolName,
      dropped,
    });
  }
  return { ...caps, secrets: kept };
}

/**
 * Parent-side `Tool` for a hosted registration (plan §4.2). Same name, schema,
 * toolset and `maxResultChars`; `execute` goes over IPC; `isAvailable` answers
 * from the host's snapshot. `alwaysInclude` is never set and
 * `outputIsUntrusted` is forced on (D17).
 */
export function createToolProxy(reg: ToolRegistration, lease: HostLease): Tool {
  return {
    name: reg.name,
    description: reg.description,
    schema: reg.schema,
    ...(reg.toolset !== undefined ? { toolset: reg.toolset } : {}),
    ...(reg.maxResultChars !== undefined ? { maxResultChars: reg.maxResultChars } : {}),
    capabilities: clampSecrets(reg.capabilities, lease, reg.name),
    ...(reg.requiresApproval !== undefined ? { requiresApproval: reg.requiresApproval } : {}),
    ...(reg.returnDirect !== undefined ? { returnDirect: reg.returnDirect } : {}),
    ...(reg.outputSchema !== undefined ? { outputSchema: reg.outputSchema } : {}),
    ...(reg.preferredModel !== undefined ? { preferredModel: reg.preferredModel } : {}),
    ...(reg.strict !== undefined ? { strict: reg.strict } : {}),
    ...(reg.settingsKey !== undefined ? { settingsKey: reg.settingsKey } : {}),
    outputIsUntrusted: true,
    isAvailable: () => lease.isToolAvailable(reg.name),
    execute: (args, ctx) => lease.callTool(requestFromContext(reg.name, args, ctx), ctx),
  };
}
