import type { McpPolicy } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { checkMcpRejectArgs } from '../agent-loop';

describe('checkMcpRejectArgs', () => {
  it('rejects a tool call whose arg value is forbidden', () => {
    const policy: McpPolicy = {
      servers: {
        slack: {
          reject_args: {
            send_message: { channel: ['#general', '#random'] },
          },
        },
      },
    };

    const result = checkMcpRejectArgs(policy, 'mcp__slack__send_message', {
      channel: '#general',
      text: 'hello',
    });

    expect(result).toBe(
      "MCP policy: argument 'channel' value '#general' is rejected for tool 'send_message' on server 'slack'",
    );
  });

  it('passes through when arg value is allowed', () => {
    const policy: McpPolicy = {
      servers: {
        slack: {
          reject_args: {
            send_message: { channel: ['#general'] },
          },
        },
      },
    };

    const result = checkMcpRejectArgs(policy, 'mcp__slack__send_message', {
      channel: '#engineering',
      text: 'hello',
    });

    expect(result).toBeUndefined();
  });

  it('passes through when tool is not in reject_args map', () => {
    const policy: McpPolicy = {
      servers: {
        slack: {
          reject_args: {
            send_message: { channel: ['#general'] },
          },
        },
      },
    };

    const result = checkMcpRejectArgs(policy, 'mcp__slack__read_channel', {
      channel: '#general',
    });

    expect(result).toBeUndefined();
  });

  it('passes through for non-MCP tools', () => {
    const policy: McpPolicy = {
      servers: {
        slack: {
          reject_args: {
            send_message: { channel: ['#general'] },
          },
        },
      },
    };

    const result = checkMcpRejectArgs(policy, 'read_file', { path: '/etc/passwd' });

    expect(result).toBeUndefined();
  });

  it('passes through when no mcpPolicy is set', () => {
    const result = checkMcpRejectArgs(undefined, 'mcp__slack__send_message', {
      channel: '#general',
    });

    expect(result).toBeUndefined();
  });
});
