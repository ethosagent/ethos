import type { McpPolicy } from '@ethosagent/types';

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
  const argRules = servers[server]?.reject_args?.[bareTool];
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
  if (servers[server]?.enabled === false) {
    return `MCP policy: server '${server}' is disabled for this personality`;
  }
  return undefined;
}
