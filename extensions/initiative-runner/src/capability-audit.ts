import { EthosError, type Tool } from '@ethosagent/types';
import { INITIATIVE_LEDGER_TOOLS } from './tool-classes';

const ENGINE_OWN: ReadonlySet<string> = new Set(INITIATIVE_LEDGER_TOOLS);

/** Why a tool is not read-only by its declared shape, or null when it passes. */
function refusalReason(tool: Tool, pluginId: string | undefined): string | null {
  const caps = tool.capabilities;
  if (caps.fs_reach?.write !== undefined) return 'declares capabilities.fs_reach.write';
  if (caps.process !== undefined) return 'declares capabilities.process';
  if (caps.storage !== undefined) return 'declares capabilities.storage (kv is writable)';
  if (tool.name.startsWith('mcp__')) return 'is an MCP tool (mcp__ prefix)';
  if (pluginId !== undefined) return `was registered by plugin ${pluginId}`;
  if (tool.alwaysInclude === true && !ENGINE_OWN.has(tool.name)) {
    return 'sets alwaysInclude and is not one of the engine tools';
  }
  return null;
}

/**
 * L3. Throws EthosError('INITIATIVE_TOOL_NOT_READ_ONLY') naming the tool and the
 * reason; the runner refuses to start. `meta` reports how the registry recorded a
 * tool (wiring binds it to `DefaultToolRegistry.getPluginId`).
 *
 * Limitation: a tool that writes through an injected service declares `{}` and
 * passes (`memory_write`). L1 (`INITIATIVE_READ_TOOLS`) and L7 (the census) cover it.
 */
export function assertReadOnlyCapabilities(
  tools: readonly Tool[],
  meta: (name: string) => { pluginId?: string },
): void {
  for (const tool of tools) {
    const reason = refusalReason(tool, meta(tool.name).pluginId);
    if (reason !== null) {
      throw new EthosError({
        code: 'INITIATIVE_TOOL_NOT_READ_ONLY',
        cause: `Tool ${tool.name} ${reason}, so an initiative run cannot use it.`,
        action: `Remove ${tool.name} from the initiative's toolset, or leave it out of the read-only registry.`,
        details: { tool: tool.name },
      });
    }
  }
}
