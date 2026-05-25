import type { McpPolicy } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { checkMcpEnabled } from '../agent-loop';

describe('checkMcpEnabled', () => {
  it('returns error string when enabled === false for the tool server', () => {
    const policy: McpPolicy = {
      servers: {
        linear: {
          enabled: false,
        },
      },
    };

    const result = checkMcpEnabled(policy, 'mcp__linear__list_issues');

    expect(result).toBe("MCP policy: server 'linear' is disabled for this personality");
  });

  it('returns undefined when enabled === true (explicitly enabled)', () => {
    const policy: McpPolicy = {
      servers: {
        linear: {
          enabled: true,
        },
      },
    };

    const result = checkMcpEnabled(policy, 'mcp__linear__list_issues');

    expect(result).toBeUndefined();
  });

  it('returns undefined when enabled is not set (omitted)', () => {
    const policy: McpPolicy = {
      servers: {
        linear: {
          tools: ['list_issues'],
        },
      },
    };

    const result = checkMcpEnabled(policy, 'mcp__linear__list_issues');

    expect(result).toBeUndefined();
  });

  it('returns undefined for non-MCP tool names', () => {
    const policy: McpPolicy = {
      servers: {
        linear: {
          enabled: false,
        },
      },
    };

    const result = checkMcpEnabled(policy, 'read_file');

    expect(result).toBeUndefined();
  });

  it('returns undefined when mcpPolicy is undefined', () => {
    const result = checkMcpEnabled(undefined, 'mcp__linear__list_issues');

    expect(result).toBeUndefined();
  });
});
