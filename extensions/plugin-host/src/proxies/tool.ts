import type { Tool } from '@ethosagent/types';
import { clampToolCapabilities } from '../capabilities';
import type { HostLease } from '../pool';
import type { ToolRegistration } from '../protocol';
import { requestFromContext } from './request';

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
    capabilities: clampToolCapabilities(
      reg.capabilities,
      lease.pluginId,
      reg.name,
      lease.emitEvent,
    ),
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
