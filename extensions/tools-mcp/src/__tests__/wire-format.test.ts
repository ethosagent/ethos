import { McpServerInfoSchema } from '@ethosagent/web-contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpServerConfig } from '../index';
import { McpClient, McpManager, rewriteDefinitionsToRefs } from '../index';

// ---------------------------------------------------------------------------
// Mock the MCP SDK
// ---------------------------------------------------------------------------

const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockClose = vi.fn().mockResolvedValue(undefined);
const mockListTools = vi.fn().mockResolvedValue({ tools: [] });
const mockCallTool = vi.fn().mockResolvedValue({
  content: [{ type: 'text', text: 'ok' }],
});
const mockPing = vi.fn().mockResolvedValue(undefined);
const mockSetNotificationHandler = vi.fn();

vi.mock('@modelcontextprotocol/sdk/client', () => ({
  Client: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.connect = mockConnect;
    this.close = mockClose;
    this.listTools = mockListTools;
    this.callTool = mockCallTool;
    this.ping = mockPing;
    this.setNotificationHandler = mockSetNotificationHandler;
    this.onclose = null;
  }),
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  // biome-ignore lint/complexity/useArrowFunction: invoked as `new StdioClientTransport(...)`; arrow functions are not constructable
  StdioClientTransport: vi.fn().mockImplementation(function () {
    return { type: 'stdio-transport' };
  }),
}));

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  // biome-ignore lint/complexity/useArrowFunction: invoked as `new SSEClientTransport(...)`; arrow functions are not constructable
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
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(name = 'srv'): McpServerConfig {
  return { name, transport: 'stdio', command: 'node' };
}

async function connectedClient(name = 'srv'): Promise<McpClient> {
  const client = new McpClient(makeConfig(name));
  await client.connect();
  return client;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Wire format conformance (Phases 2.3-2.7)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListTools.mockResolvedValue({ tools: [] });
    mockCallTool.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
    });
  });

  // -------------------------------------------------------------------------
  // 2.3: notifications/tools/list_changed
  // -------------------------------------------------------------------------

  describe('notifications/tools/list_changed (Phase 2.3)', () => {
    it('registers a notification handler on connect', async () => {
      await connectedClient();
      expect(mockSetNotificationHandler).toHaveBeenCalledTimes(1);
      const args = mockSetNotificationHandler.mock.calls[0];
      expect(args[0]).toEqual({ method: 'notifications/tools/list_changed' });
      expect(typeof args[1]).toBe('function');
    });

    it('re-fetches tools when notification fires', async () => {
      mockListTools.mockResolvedValue({
        tools: [{ name: 'alpha', description: 'A', inputSchema: { type: 'object' } }],
      });

      const client = await connectedClient();
      const collected: unknown[] = [];
      client.onToolsChanged = (tools) => collected.push(tools);

      // Simulate the server sending the notification
      const handler = mockSetNotificationHandler.mock.calls[0][1] as () => Promise<void>;
      mockListTools.mockResolvedValue({
        tools: [{ name: 'beta', description: 'B', inputSchema: { type: 'object' } }],
      });

      await handler();

      expect(collected).toHaveLength(1);
      const tools = collected[0] as Array<{ name: string }>;
      expect(tools).toHaveLength(1);
      expect(tools[0]?.name).toBe('beta');
    });

    it('McpManager updates tools on list_changed', async () => {
      mockListTools.mockResolvedValue({
        tools: [{ name: 'old_tool', description: 'Old', inputSchema: { type: 'object' } }],
      });

      const manager = new McpManager([makeConfig('srv')]);
      await manager.connect();

      expect(manager.getTools()).toHaveLength(1);
      expect(manager.getTools()[0]?.name).toBe('mcp__srv__old_tool');

      // Simulate list_changed notification
      const handler = mockSetNotificationHandler.mock.calls[0][1] as () => Promise<void>;
      mockListTools.mockResolvedValue({
        tools: [
          { name: 'new_tool_a', description: 'A', inputSchema: { type: 'object' } },
          { name: 'new_tool_b', description: 'B', inputSchema: { type: 'object' } },
        ],
      });

      await handler();

      const tools = manager.getTools();
      expect(tools).toHaveLength(2);
      expect(tools.map((t) => t.name)).toEqual(['mcp__srv__new_tool_a', 'mcp__srv__new_tool_b']);
    });

    it('does not crash if listTools fails during notification', async () => {
      const client = await connectedClient();
      client.onToolsChanged = vi.fn();

      const handler = mockSetNotificationHandler.mock.calls[0][1] as () => Promise<void>;
      mockListTools.mockRejectedValueOnce(new Error('server gone'));

      // Should not throw
      await handler();
      expect(client.onToolsChanged).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 2.4: structuredContent handling
  // -------------------------------------------------------------------------

  describe('structuredContent (Phase 2.4)', () => {
    it('serializes structuredContent as JSON when present', async () => {
      mockCallTool.mockResolvedValue({
        content: [],
        structuredContent: { items: [1, 2, 3], total: 3 },
      });

      const client = await connectedClient();
      const result = await client.callTool('query', {});

      expect(result.ok).toBe(true);
      if (result.ok) {
        const parsed = JSON.parse(result.value);
        expect(parsed).toEqual({ items: [1, 2, 3], total: 3 });
      }
    });

    it('structuredContent with isError returns error', async () => {
      mockCallTool.mockResolvedValue({
        content: [],
        structuredContent: { code: 'NOT_FOUND', message: 'missing' },
        isError: true,
      });

      const client = await connectedClient();
      const result = await client.callTool('query', {});

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('execution_failed');
        expect(result.error).toContain('NOT_FOUND');
      }
    });
  });

  // -------------------------------------------------------------------------
  // 2.4 continued: no_mcp sentinel
  // -------------------------------------------------------------------------

  describe('no_mcp sentinel (Phase 2.4)', () => {
    it('falls back to content blocks when structuredContent is no_mcp', async () => {
      mockCallTool.mockResolvedValue({
        content: [{ type: 'text', text: 'fallback text' }],
        structuredContent: 'no_mcp',
      });

      const client = await connectedClient();
      const result = await client.callTool('echo', {});

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe('fallback text');
      }
    });
  });

  // -------------------------------------------------------------------------
  // 2.5: Merge structuredContent + content
  // -------------------------------------------------------------------------

  describe('merge structuredContent + content (Phase 2.5)', () => {
    it('merges text content and structuredContent', async () => {
      mockCallTool.mockResolvedValue({
        content: [{ type: 'text', text: 'Summary: found 3 items' }],
        structuredContent: { items: ['a', 'b', 'c'] },
      });

      const client = await connectedClient();
      const result = await client.callTool('search', {});

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toContain('Summary: found 3 items');
        expect(result.value).toContain('--- Structured Data ---');
        expect(result.value).toContain('"items"');
      }
    });

    it('uses only structuredContent JSON when content has no text blocks', async () => {
      mockCallTool.mockResolvedValue({
        content: [{ type: 'image', data: 'abc', mimeType: 'image/png' }],
        structuredContent: { status: 'ok' },
      });

      const client = await connectedClient();
      const result = await client.callTool('render', {});

      expect(result.ok).toBe(true);
      if (result.ok) {
        // No text blocks → no merge header, just the JSON
        const parsed = JSON.parse(result.value);
        expect(parsed).toEqual({ status: 'ok' });
      }
    });

    it('merged result surfaces error when isError is true', async () => {
      mockCallTool.mockResolvedValue({
        content: [{ type: 'text', text: 'Error context' }],
        structuredContent: { code: 500 },
        isError: true,
      });

      const client = await connectedClient();
      const result = await client.callTool('fail', {});

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('Error context');
        expect(result.error).toContain('--- Structured Data ---');
      }
    });
  });

  // -------------------------------------------------------------------------
  // 2.6: Image content blocks
  // -------------------------------------------------------------------------

  describe('image content blocks (Phase 2.6)', () => {
    it('represents image blocks as text descriptions', async () => {
      const base64Data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAA';
      mockCallTool.mockResolvedValue({
        content: [{ type: 'image', data: base64Data, mimeType: 'image/png' }],
      });

      const client = await connectedClient();
      const result = await client.callTool('screenshot', {});

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toContain('[Image: image/png,');
        expect(result.value).toContain('bytes base64]');
        // Should NOT contain the raw base64
        expect(result.value).not.toContain(base64Data);
      }
    });

    it('handles mixed text and image blocks', async () => {
      mockCallTool.mockResolvedValue({
        content: [
          { type: 'text', text: 'Chart generated' },
          { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' },
          { type: 'text', text: 'Done' },
        ],
      });

      const client = await connectedClient();
      const result = await client.callTool('chart', {});

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toContain('Chart generated');
        expect(result.value).toContain('[Image: image/jpeg, 4 bytes base64]');
        expect(result.value).toContain('Done');
      }
    });

    it('handles image block with missing mimeType', async () => {
      mockCallTool.mockResolvedValue({
        content: [{ type: 'image', data: 'xx' }],
      });

      const client = await connectedClient();
      const result = await client.callTool('img', {});

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toContain('[Image: image/unknown,');
      }
    });

    it('handles image block with missing data', async () => {
      mockCallTool.mockResolvedValue({
        content: [{ type: 'image', mimeType: 'image/png' }],
      });

      const client = await connectedClient();
      const result = await client.callTool('img', {});

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toContain('[Image: image/png, 0 bytes base64]');
      }
    });
  });

  // -------------------------------------------------------------------------
  // 2.7: $defs rewrite
  // -------------------------------------------------------------------------

  describe('rewriteDefinitionsToRefs (Phase 2.7)', () => {
    it('renames definitions to $defs', () => {
      const schema = {
        type: 'object',
        definitions: {
          Foo: { type: 'string' },
        },
        properties: {
          foo: { $ref: '#/definitions/Foo' },
        },
      };

      const result = rewriteDefinitionsToRefs(schema);

      expect(result.$defs).toEqual({ Foo: { type: 'string' } });
      expect(result.definitions).toBeUndefined();
      const props = result.properties as Record<string, Record<string, unknown>>;
      expect(props.foo.$ref).toBe('#/$defs/Foo');
    });

    it('preserves $defs if already present', () => {
      const schema = {
        type: 'object',
        definitions: { Old: { type: 'number' } },
        $defs: { New: { type: 'string' } },
      };

      const result = rewriteDefinitionsToRefs(schema);

      // $defs should not be overwritten by definitions
      expect(result.$defs).toEqual({ New: { type: 'string' } });
      // definitions stays because $defs already exists
      expect(result.definitions).toEqual({ Old: { type: 'number' } });
    });

    it('handles nested definitions and refs', () => {
      const schema = {
        type: 'object',
        definitions: {
          Address: {
            type: 'object',
            definitions: {
              ZipCode: { type: 'string', pattern: '^\\d{5}$' },
            },
            properties: {
              zip: { $ref: '#/definitions/ZipCode' },
            },
          },
        },
        properties: {
          home: { $ref: '#/definitions/Address' },
        },
      };

      const result = rewriteDefinitionsToRefs(schema);

      // Top-level: definitions → $defs
      expect(result.$defs).toBeDefined();
      expect(result.definitions).toBeUndefined();

      // Nested: definitions → $defs
      const address = (result.$defs as Record<string, Record<string, unknown>>).Address;
      expect(address.$defs).toBeDefined();
      expect(address.definitions).toBeUndefined();

      // $ref paths rewritten
      const props = result.properties as Record<string, Record<string, unknown>>;
      expect(props.home.$ref).toBe('#/$defs/Address');
      const addrProps = address.properties as Record<string, Record<string, unknown>>;
      expect(addrProps.zip.$ref).toBe('#/$defs/ZipCode');
    });

    it('handles $ref in arrays (e.g. oneOf)', () => {
      const schema = {
        type: 'object',
        definitions: {
          Cat: { type: 'object' },
          Dog: { type: 'object' },
        },
        properties: {
          pet: {
            oneOf: [{ $ref: '#/definitions/Cat' }, { $ref: '#/definitions/Dog' }],
          },
        },
      };

      const result = rewriteDefinitionsToRefs(schema);
      const pet = (result.properties as Record<string, Record<string, unknown>>).pet;
      const oneOf = pet.oneOf as Array<Record<string, unknown>>;
      expect(oneOf[0].$ref).toBe('#/$defs/Cat');
      expect(oneOf[1].$ref).toBe('#/$defs/Dog');
    });

    it('does not mutate the original schema', () => {
      const schema = {
        type: 'object',
        definitions: { X: { type: 'string' } },
        properties: { x: { $ref: '#/definitions/X' } },
      };
      const original = JSON.parse(JSON.stringify(schema));

      rewriteDefinitionsToRefs(schema);

      expect(schema).toEqual(original);
    });

    it('passes through schema without definitions unchanged', () => {
      const schema = {
        type: 'object',
        properties: { name: { type: 'string' } },
      };

      const result = rewriteDefinitionsToRefs(schema);

      expect(result).toEqual(schema);
      expect(result.definitions).toBeUndefined();
      expect(result.$defs).toBeUndefined();
    });

    it('is applied to tool schemas via listTools', async () => {
      mockListTools.mockResolvedValue({
        tools: [
          {
            name: 'query',
            description: 'Run a query',
            inputSchema: {
              type: 'object',
              definitions: {
                Filter: { type: 'object', properties: { field: { type: 'string' } } },
              },
              properties: {
                filter: { $ref: '#/definitions/Filter' },
              },
            },
          },
        ],
      });

      const client = await connectedClient();
      const tools = await client.listTools();

      const schema = tools[0]?.inputSchema;
      expect(schema?.$defs).toBeDefined();
      expect(schema?.definitions).toBeUndefined();
      const filterRef = (schema?.properties as Record<string, Record<string, unknown>>)?.filter;
      expect(filterRef?.$ref).toBe('#/$defs/Filter');
    });
  });

  // -------------------------------------------------------------------------
  // McpServerConfig new fields (Phase A — OAuth config shape)
  // -------------------------------------------------------------------------

  describe('McpServerConfig new fields', () => {
    it('accepts auth.dcr sub-block', () => {
      const config: McpServerConfig = {
        name: 'linear',
        transport: 'streamable-http',
        url: 'https://mcp.linear.app/mcp',
        auth: {
          type: 'oauth2',
          authorization_endpoint: 'https://linear.app/oauth/authorize',
          token_endpoint: 'https://linear.app/api/oauth/token',
          client_id: 'dcr-client-123',
          dcr: {
            registration_endpoint: 'https://linear.app/api/oauth/register',
            client_id_issued_at: 1716100000,
            registration_client_uri: 'https://linear.app/api/oauth/register/dcr-client-123',
          },
        },
        created_via: 'ui',
      };

      expect(config.auth?.dcr?.registration_endpoint).toBe('https://linear.app/api/oauth/register');
      expect(config.created_via).toBe('ui');
    });

    it('auth fields are optional for backward compat', () => {
      const config: McpServerConfig = {
        name: 'old-server',
        transport: 'stdio',
        command: 'node',
      };
      expect(config.auth).toBeUndefined();
      expect(config.created_via).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // McpServerInfoSchema — auth_status / created_via (Phase B.3)
  // -------------------------------------------------------------------------

  describe('McpServerInfoSchema auth_status and created_via', () => {
    it('accepts auth_status: null and created_via: null', () => {
      const result = McpServerInfoSchema.safeParse({
        name: 'test-srv',
        transport: 'stdio',
        command: 'node',
        url: null,
        auth_status: null,
        created_via: null,
      });
      expect(result.success).toBe(true);
    });

    it('accepts auth_status: "authorized" and created_via: "ui"', () => {
      const result = McpServerInfoSchema.safeParse({
        name: 'linear',
        transport: 'streamable-http',
        command: null,
        url: 'https://mcp.linear.app/mcp',
        auth_status: 'authorized',
        created_via: 'ui',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.auth_status).toBe('authorized');
        expect(result.data.created_via).toBe('ui');
      }
    });

    it('rejects invalid auth_status values', () => {
      const result = McpServerInfoSchema.safeParse({
        name: 'bad-srv',
        transport: 'stdio',
        command: 'node',
        url: null,
        auth_status: 'bogus',
        created_via: null,
      });
      expect(result.success).toBe(false);
    });
  });
});
