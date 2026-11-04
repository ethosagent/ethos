import type { Tool } from '@ethosagent/types';
import type { ToolRegistration } from '../protocol';

/** A recorded tool as plain data. `isAvailable` is sampled now; `execute` stays here. */
export function toolToWire(tool: Tool): ToolRegistration {
  let available = true;
  try {
    available = tool.isAvailable ? tool.isAvailable() : true;
  } catch {
    available = false;
  }
  return {
    kind: 'tool',
    name: tool.name,
    description: tool.description,
    schema: tool.schema,
    ...(tool.toolset !== undefined ? { toolset: tool.toolset } : {}),
    ...(tool.maxResultChars !== undefined ? { maxResultChars: tool.maxResultChars } : {}),
    capabilities: tool.capabilities ?? {},
    available,
    ...(tool.requiresApproval !== undefined ? { requiresApproval: tool.requiresApproval } : {}),
    ...(tool.returnDirect !== undefined ? { returnDirect: tool.returnDirect } : {}),
    ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
    ...(tool.preferredModel !== undefined ? { preferredModel: tool.preferredModel } : {}),
    ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
    ...(tool.settingsKey !== undefined ? { settingsKey: tool.settingsKey } : {}),
  };
}
