import { McpAddServerInputSchema, McpPolicySchema, McpRenameInputSchema, McpScopeStatusOutputSchema, McpServerInfoSchema, McpServerPolicySchema, McpServerToolsInputSchema, McpServerToolsOutputSchema, McpUpdateTokenInputSchema, McpValidateConfigInputSchema, McpValidateConfigOutputSchema, } from '@ethosagent/web-contracts';
import { describe, expect, it } from 'vitest';
describe('MCP issues — schema validation', () => {
    // -------------------------------------------------------------------------
    // Issue 1 — Stdio in addServer schema
    // -------------------------------------------------------------------------
    describe('McpAddServerInputSchema — stdio transport', () => {
        it('accepts stdio transport with command', () => {
            const result = McpAddServerInputSchema.safeParse({
                name: 'local-server',
                transport: 'stdio',
                command: 'npx my-server',
            });
            expect(result.success).toBe(true);
        });
        it('accepts stdio transport with args and env', () => {
            const result = McpAddServerInputSchema.safeParse({
                name: 'local-server',
                transport: 'stdio',
                command: 'npx',
                args: ['my-server', '--flag'],
                env: { MY_VAR: 'value' },
            });
            expect(result.success).toBe(true);
        });
        it('accepts streamable-http with url', () => {
            const result = McpAddServerInputSchema.safeParse({
                name: 'remote',
                transport: 'streamable-http',
                url: 'https://mcp.example.com/mcp',
            });
            expect(result.success).toBe(true);
        });
    });
    // -------------------------------------------------------------------------
    // Issue 2 — Enabled field in McpPolicy schema
    // -------------------------------------------------------------------------
    describe('McpPolicy — enabled field', () => {
        it('accepts enabled: false in server policy', () => {
            const result = McpPolicySchema.safeParse({
                servers: {
                    'my-server': { enabled: false },
                },
            });
            expect(result.success).toBe(true);
        });
        it('enabled defaults to undefined (treated as true)', () => {
            const result = McpServerPolicySchema.safeParse({
                tools: ['read_file'],
            });
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.enabled).toBeUndefined();
            }
        });
    });
    // -------------------------------------------------------------------------
    // Issue 4 — mcpResultLimitChars
    // -------------------------------------------------------------------------
    describe('McpServerInfoSchema — mcpResultLimitChars', () => {
        it('accepts mcpResultLimitChars in server info', () => {
            const result = McpServerInfoSchema.safeParse({
                name: 'test',
                transport: 'streamable-http',
                command: null,
                url: 'https://example.com',
                auth_status: null,
                created_via: null,
                mcpResultLimitChars: 100000,
                deprecated: false,
            });
            expect(result.success).toBe(true);
        });
        it('accepts null mcpResultLimitChars', () => {
            const result = McpServerInfoSchema.safeParse({
                name: 'test',
                transport: 'stdio',
                command: '/usr/bin/my-tool',
                url: null,
                auth_status: null,
                created_via: null,
                mcpResultLimitChars: null,
                deprecated: null,
            });
            expect(result.success).toBe(true);
        });
    });
    // -------------------------------------------------------------------------
    // Issue 5 — Rename schemas
    // -------------------------------------------------------------------------
    describe('McpRenameInputSchema', () => {
        it('validates rename input', () => {
            const result = McpRenameInputSchema.safeParse({
                oldName: 'server-a',
                newName: 'server-b',
            });
            expect(result.success).toBe(true);
        });
        it('rejects empty newName', () => {
            const result = McpRenameInputSchema.safeParse({
                oldName: 'server-a',
                newName: '',
            });
            expect(result.success).toBe(false);
        });
    });
    // -------------------------------------------------------------------------
    // Issue 6 — UpdateToken schemas
    // -------------------------------------------------------------------------
    describe('McpUpdateTokenInputSchema', () => {
        it('validates update token input', () => {
            const result = McpUpdateTokenInputSchema.safeParse({
                serverName: 'my-server',
                token: 'sk-abc123',
            });
            expect(result.success).toBe(true);
        });
    });
    // -------------------------------------------------------------------------
    // Issue 8 — Scope status schemas
    // -------------------------------------------------------------------------
    describe('McpScopeStatusOutputSchema', () => {
        it('accepts scope status output', () => {
            const result = McpScopeStatusOutputSchema.safeParse({
                outcome: 'match',
                declaredScopes: ['read', 'write'],
                actualScopes: ['read', 'write'],
            });
            expect(result.success).toBe(true);
        });
    });
    // -------------------------------------------------------------------------
    // Issue 9 — Paginated server tools
    // -------------------------------------------------------------------------
    describe('McpServerToolsInputSchema / McpServerToolsOutputSchema', () => {
        it('accepts limit and cursor in server tools input', () => {
            const result = McpServerToolsInputSchema.safeParse({
                personalityId: 'default',
                serverName: 'my-server',
                limit: 25,
                cursor: '50',
            });
            expect(result.success).toBe(true);
        });
        it('accepts nextCursor in server tools output', () => {
            const result = McpServerToolsOutputSchema.safeParse({
                available: true,
                tools: [{ name: 'read_file', description: 'Read a file' }],
                nextCursor: '25',
            });
            expect(result.success).toBe(true);
        });
    });
    // -------------------------------------------------------------------------
    // Issue 10 — Validate config schemas
    // -------------------------------------------------------------------------
    describe('McpValidateConfigInputSchema / McpValidateConfigOutputSchema', () => {
        it('validates config input for stdio', () => {
            const result = McpValidateConfigInputSchema.safeParse({
                transport: 'stdio',
                command: 'npx my-server',
            });
            expect(result.success).toBe(true);
        });
        it('validates config output with errors', () => {
            const result = McpValidateConfigOutputSchema.safeParse({
                valid: false,
                errors: [{ field: 'url', message: 'Required for HTTP transports' }],
            });
            expect(result.success).toBe(true);
        });
    });
});
