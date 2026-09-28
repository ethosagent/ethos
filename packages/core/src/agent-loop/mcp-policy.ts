import type { McpPolicy } from '@ethosagent/types';
import { mcpServerSegment, mcpToolName } from '../tool-registry';

/**
 * The mcp.yaml server key whose provider-safe half is `segment` (UBP-035).
 * mcp.yaml names servers by their ORIGINAL name, and `mcpToolName`
 * (tool-registry.ts) rewrites a non-conforming one, so a key matches either
 * verbatim or through `mcpServerSegment` — the same rule the registry's
 * allowlist gates use. Pinned by __tests__/mcp-policy-rewritten-names.test.ts.
 */
function policyServerKey(servers: Record<string, unknown>, segment: string): string | undefined {
  return Object.keys(servers).find((k) => k === segment || mcpServerSegment(k) === segment);
}

// ---------------------------------------------------------------------------
// MCP reject_args policy — standalone so it can be tested without constructing
// a full AgentLoop.  Evaluates the per-server / per-tool forbidden-arg-value
// rules from mcp.yaml.  Returns an error string when the call should be
// rejected, or undefined when it is allowed through.
// ---------------------------------------------------------------------------
export function checkMcpRejectArgs(
  mcpPolicy: McpPolicy | undefined,
  toolName: string,
  args: unknown,
): string | undefined {
  const servers = mcpPolicy?.servers;
  if (!servers || !toolName.startsWith('mcp__')) return undefined;

  const firstSep = toolName.indexOf('__');
  const secondSep = toolName.indexOf('__', firstSep + 2);
  if (secondSep === -1) return undefined;

  const server = toolName.slice(firstSep + 2, secondSep);
  const bareTool = toolName.slice(secondSep + 2);
  const serverKey = policyServerKey(servers, server);
  const rules = serverKey !== undefined ? servers[serverKey]?.reject_args : undefined;
  const toolKey =
    rules && serverKey !== undefined
      ? Object.keys(rules).find((t) => t === bareTool || mcpToolName(serverKey, t) === toolName)
      : undefined;
  const argRules = toolKey !== undefined ? rules?.[toolKey] : undefined;
  if (!argRules) return undefined;

  const typedArgs = args as Record<string, unknown>;
  for (const [argName, forbiddenValues] of Object.entries(argRules)) {
    const value = typedArgs[argName];
    if (typeof value === 'string' && forbiddenValues.includes(value)) {
      return `MCP policy: argument '${argName}' value '${value}' is rejected for tool '${bareTool}' on server '${server}'`;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// MCP enabled policy — standalone so it can be tested without constructing
// a full AgentLoop.  Returns an error string when the tool's server has
// enabled === false in the personality's mcp.yaml, undefined otherwise.
// ---------------------------------------------------------------------------
export function checkMcpEnabled(
  mcpPolicy: McpPolicy | undefined,
  toolName: string,
): string | undefined {
  const servers = mcpPolicy?.servers;
  if (!servers || !toolName.startsWith('mcp__')) return undefined;

  const firstSep = toolName.indexOf('__');
  const secondSep = toolName.indexOf('__', firstSep + 2);
  if (secondSep === -1) return undefined;

  const server = toolName.slice(firstSep + 2, secondSep);
  const serverKey = policyServerKey(servers, server);
  if (serverKey !== undefined && servers[serverKey]?.enabled === false) {
    return `MCP policy: server '${server}' is disabled for this personality`;
  }
  return undefined;
}
