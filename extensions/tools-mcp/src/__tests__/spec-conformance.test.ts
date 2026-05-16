import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { McpClient, McpManager, loadMcpConfig } from '../index';
import type { McpServerConfig } from '../index';

// ---------------------------------------------------------------------------
// Mock the MCP SDK — no real subprocess or network transport
// ---------------------------------------------------------------------------

const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockClose = vi.fn().mockResolvedValue(undefined);
const mockListTools = vi.fn().mockResolvedValue({ tools: [] });
const mockCallTool = vi.fn().mockResolvedValue({
  content: [{ type: 'text', text: 'ok' }],
});
const mockPing = vi.fn().mockResolvedValue(undefined);

vi.mock('@modelcontextprotocol/sdk/client', () => ({
  Client: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.connect = mockConnect;
    this.close = mockClose;
    this.listTools = mockListTools;
    this.callTool = mockCallTool;
    this.ping = mockPing;
    this.setNotificationHandler = vi.fn();
    this.onclose = null;
  }),
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn().mockImplementation(function () {
    return { type: 'stdio-transport' };
  }),
}));

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: vi.fn().mockImplementation(function () {
    return { type: 'sse-transport' };
  }),
}));

vi.mock('@modelcontextprotocol/sdk/types.js', () => ({
  ToolListChangedNotificationSchema: { method: 'notifications/tools/list_changed' },
}));

vi.mock('@ethosagent/safety-scanner', () => ({
  buildMcpEnv: vi.fn().mockReturnValue({ HOME: '/tmp', PATH: '/usr/bin' }),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MCP spec conformance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListTools.mockResolvedValue({ tools: [] });
    mockCallTool.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
    });
  });

  // -------------------------------------------------------------------------
  // McpClient construction
  // -------------------------------------------------------------------------

  describe('McpClient construction', () => {
    it('instantiates with stdio config', () => {
      const config: McpServerConfig = {
        name: 'test-stdio',
        transport: 'stdio',
        command: '/usr/bin/node',
        args: ['server.js'],
      };
      const client = new McpClient(config);
      expect(client.name).toBe('test-stdio');
      expect(client.isConnected()).toBe(false);
    });

    it('instantiates with sse config', () => {
      const config: McpServerConfig = {
        name: 'test-sse',
        transport: 'sse',
        url: 'http://localhost:3000/sse',
      };
      const client = new McpClient(config);
      expect(client.name).toBe('test-sse');
      expect(client.isConnected()).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Config validation
  // -------------------------------------------------------------------------

  describe('config validation', () => {
    it('stdio transport requires command', async () => {
      const config: McpServerConfig = {
        name: 'missing-cmd',
        transport: 'stdio',
        // command intentionally omitted
      };
      const client = new McpClient(config);
      await expect(client.connect()).rejects.toThrow(
        "stdio transport requires 'command'",
      );
    });

    it('sse transport requires url', async () => {
      const config: McpServerConfig = {
        name: 'missing-url',
        transport: 'sse',
        // url intentionally omitted
      };
      const client = new McpClient(config);
      await expect(client.connect()).rejects.toThrow(
        "sse transport requires 'url'",
      );
    });
  });

  // -------------------------------------------------------------------------
  // McpClient connect / disconnect
  // -------------------------------------------------------------------------

  describe('McpClient connect and disconnect', () => {
    it('connects and marks connected', async () => {
      const config: McpServerConfig = {
        name: 'srv',
        transport: 'stdio',
        command: 'node',
      };
      const client = new McpClient(config);
      await client.connect();
      expect(client.isConnected()).toBe(true);
      expect(mockConnect).toHaveBeenCalledTimes(1);
    });

    it('disconnects cleanly', async () => {
      const config: McpServerConfig = {
        name: 'srv',
        transport: 'stdio',
        command: 'node',
      };
      const client = new McpClient(config);
      await client.connect();
      await client.disconnect();
      expect(client.isConnected()).toBe(false);
      expect(mockClose).toHaveBeenCalledTimes(1);
    });

    it('disconnect clears reconnect timer', async () => {
      vi.useFakeTimers();
      const config: McpServerConfig = {
        name: 'srv',
        transport: 'stdio',
        command: 'node',
      };
      const client = new McpClient(config);
      await client.connect();

      // Simulate onclose triggering reconnect schedule
      const { Client } = await import('@modelcontextprotocol/sdk/client');
      const sdkInstance = vi.mocked(Client).mock.results[0]?.value;
      if (sdkInstance?.onclose) sdkInstance.onclose();

      // Now disconnect — should clear the scheduled reconnect
      await client.disconnect();
      expect(client.isConnected()).toBe(false);

      // Advance timers — no reconnect should fire
      vi.advanceTimersByTime(60_000);
      vi.useRealTimers();
    });
  });

  // -------------------------------------------------------------------------
  // callTool
  // -------------------------------------------------------------------------

  describe('callTool', () => {
    it('returns not_available when disconnected', async () => {
      const config: McpServerConfig = {
        name: 'offline',
        transport: 'stdio',
        command: 'node',
      };
      const client = new McpClient(config);
      // Never connect

      const result = await client.callTool('anything', {});
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('not_available');
        expect(result.error).toContain('not connected');
      }
    });

    it('returns success with text content', async () => {
      mockCallTool.mockResolvedValue({
        content: [{ type: 'text', text: 'hello world' }],
      });

      const config: McpServerConfig = {
        name: 'srv',
        transport: 'stdio',
        command: 'node',
      };
      const client = new McpClient(config);
      await client.connect();

      const result = await client.callTool('echo', { message: 'hello world' });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe('hello world');
    });

    it('returns error when tool returns isError:true', async () => {
      mockCallTool.mockResolvedValue({
        content: [{ type: 'text', text: 'something broke' }],
        isError: true,
      });

      const config: McpServerConfig = {
        name: 'srv',
        transport: 'stdio',
        command: 'node',
      };
      const client = new McpClient(config);
      await client.connect();

      const result = await client.callTool('fail', {});
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('execution_failed');
        expect(result.error).toBe('something broke');
      }
    });
  });

  // -------------------------------------------------------------------------
  // adaptMcpTool — tool name prefixing
  // -------------------------------------------------------------------------

  describe('adaptMcpTool (tool name prefixing)', () => {
    it('produces mcp__<server>__<tool> name', async () => {
      mockListTools.mockResolvedValue({
        tools: [
          {
            name: 'read_file',
            description: 'Reads a file',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      });

      const manager = new McpManager([
        { name: 'filesystem', transport: 'stdio', command: 'node' },
      ]);
      await manager.connect();

      const tools = manager.getTools();
      expect(tools).toHaveLength(1);
      expect(tools[0]?.name).toBe('mcp__filesystem__read_file');
    });

    it('preserves tool description and schema', async () => {
      const schema = {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      };
      mockListTools.mockResolvedValue({
        tools: [
          {
            name: 'read',
            description: 'Read files from disk',
            inputSchema: schema,
          },
        ],
      });

      const manager = new McpManager([
        { name: 'fs', transport: 'stdio', command: 'node' },
      ]);
      await manager.connect();

      const tool = manager.getTools()[0];
      expect(tool?.description).toBe('Read files from disk');
      expect(tool?.schema).toEqual(schema);
    });
  });

  // -------------------------------------------------------------------------
  // McpManager
  // -------------------------------------------------------------------------

  describe('McpManager', () => {
    it('connects multiple clients', async () => {
      const manager = new McpManager([
        { name: 'a', transport: 'stdio', command: 'node' },
        { name: 'b', transport: 'stdio', command: 'node' },
      ]);
      await manager.connect();
      // connect called once per client
      expect(mockConnect).toHaveBeenCalledTimes(2);
    });

    it('collects tools from all clients', async () => {
      let callCount = 0;
      mockListTools.mockImplementation(() => {
        callCount++;
        return Promise.resolve({
          tools: [
            {
              name: `tool_${callCount}`,
              description: `Tool ${callCount}`,
              inputSchema: { type: 'object', properties: {} },
            },
          ],
        });
      });

      const manager = new McpManager([
        { name: 'server_a', transport: 'stdio', command: 'node' },
        { name: 'server_b', transport: 'stdio', command: 'node' },
      ]);
      await manager.connect();

      const tools = manager.getTools();
      expect(tools).toHaveLength(2);
      const names = tools.map((t) => t.name);
      expect(names).toContain('mcp__server_a__tool_1');
      expect(names).toContain('mcp__server_b__tool_2');
    });

    it('handles connect failure gracefully', async () => {
      mockConnect.mockRejectedValueOnce(new Error('ENOENT'));
      mockConnect.mockResolvedValueOnce(undefined);
      mockListTools.mockResolvedValue({
        tools: [
          {
            name: 'ok_tool',
            description: 'Works',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      });

      const manager = new McpManager([
        { name: 'broken', transport: 'stdio', command: 'missing-binary' },
        { name: 'working', transport: 'stdio', command: 'node' },
      ]);
      await manager.connect();

      const tools = manager.getTools();
      // Only the working server's tools should be present
      expect(tools.some((t) => t.name === 'mcp__working__ok_tool')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // loadMcpConfig
  // -------------------------------------------------------------------------

  describe('loadMcpConfig', () => {
    it('returns empty array for missing file', async () => {
      const storage = new InMemoryStorage();
      const configs = await loadMcpConfig(storage);
      expect(configs).toEqual([]);
    });

    it('returns empty array for invalid JSON', async () => {
      const storage = new InMemoryStorage();
      const dir = join(homedir(), '.ethos');
      await storage.mkdir(dir);
      const path = join(dir, 'mcp.json');
      await storage.write(path, 'not valid json {{{');
      const configs = await loadMcpConfig(storage);
      expect(configs).toEqual([]);
    });

    it('parses valid config', async () => {
      const storage = new InMemoryStorage();
      const dir = join(homedir(), '.ethos');
      await storage.mkdir(dir);
      const path = join(dir, 'mcp.json');
      const expected: McpServerConfig[] = [
        { name: 'my-server', transport: 'stdio', command: 'node', args: ['srv.js'] },
        { name: 'remote', transport: 'sse', url: 'http://localhost:8080/sse' },
      ];
      await storage.write(path, JSON.stringify(expected));
      const configs = await loadMcpConfig(storage);
      expect(configs).toEqual(expected);
    });
  });
});
