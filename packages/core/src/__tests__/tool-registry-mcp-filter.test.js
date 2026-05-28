import { describe, expect, it } from 'vitest';
import { DefaultToolRegistry } from '../tool-registry';
function makeTool(name, toolset = 'test') {
    return {
        name,
        description: `test tool ${name}`,
        schema: {},
        toolset,
        capabilities: {},
        execute: async () => ({ ok: true, value: 'ok' }),
    };
}
describe('passesFilter — allowedMcpTools', () => {
    it('server absent from allowedMcpTools → all tools pass', () => {
        const reg = new DefaultToolRegistry();
        reg.register(makeTool('mcp__linear__list_issues'));
        reg.register(makeTool('mcp__linear__save_issue'));
        const filterOpts = {
            allowedMcpServers: ['linear'],
            allowedMcpTools: { slack: ['search_public'] },
        };
        const defs = reg.toDefinitions(undefined, filterOpts);
        const names = defs.map((d) => d.name);
        expect(names).toContain('mcp__linear__list_issues');
        expect(names).toContain('mcp__linear__save_issue');
    });
    it('server present with tools list → only listed tools pass', () => {
        const reg = new DefaultToolRegistry();
        reg.register(makeTool('mcp__linear__list_issues'));
        reg.register(makeTool('mcp__linear__save_issue'));
        const filterOpts = {
            allowedMcpServers: ['linear'],
            allowedMcpTools: { linear: ['list_issues'] },
        };
        const defs = reg.toDefinitions(undefined, filterOpts);
        const names = defs.map((d) => d.name);
        expect(names).toContain('mcp__linear__list_issues');
        expect(names).not.toContain('mcp__linear__save_issue');
    });
    it('allowedMcpTools undefined → all tools pass', () => {
        const reg = new DefaultToolRegistry();
        reg.register(makeTool('mcp__linear__list_issues'));
        reg.register(makeTool('mcp__linear__save_issue'));
        const filterOpts = {
            allowedMcpServers: ['linear'],
        };
        const defs = reg.toDefinitions(undefined, filterOpts);
        const names = defs.map((d) => d.name);
        expect(names).toContain('mcp__linear__list_issues');
        expect(names).toContain('mcp__linear__save_issue');
    });
    it('non-MCP tools unaffected by allowedMcpTools', () => {
        const reg = new DefaultToolRegistry();
        reg.register(makeTool('read_file'));
        reg.register(makeTool('mcp__linear__list_issues'));
        const filterOpts = {
            allowedMcpServers: ['linear'],
            allowedMcpTools: { linear: ['list_issues'] },
        };
        const defs = reg.toDefinitions(['read_file'], filterOpts);
        const names = defs.map((d) => d.name);
        expect(names).toContain('read_file');
    });
    it('toDefinitions honours allowedMcpTools filter', () => {
        const reg = new DefaultToolRegistry();
        reg.register(makeTool('mcp__slack__search_public'));
        reg.register(makeTool('mcp__slack__send_message'));
        reg.register(makeTool('mcp__slack__read_channel'));
        const filterOpts = {
            allowedMcpServers: ['slack'],
            allowedMcpTools: { slack: ['search_public', 'read_channel'] },
        };
        const defs = reg.toDefinitions(undefined, filterOpts);
        const names = defs.map((d) => d.name);
        expect(names).toContain('mcp__slack__search_public');
        expect(names).toContain('mcp__slack__read_channel');
        expect(names).not.toContain('mcp__slack__send_message');
    });
    it('executeParallel rejects tools blocked by allowedMcpTools', async () => {
        const reg = new DefaultToolRegistry();
        reg.register(makeTool('mcp__linear__list_issues'));
        reg.register(makeTool('mcp__linear__save_issue'));
        const filterOpts = {
            allowedMcpServers: ['linear'],
            allowedMcpTools: { linear: ['list_issues'] },
        };
        const results = await reg.executeParallel([
            { toolCallId: '1', name: 'mcp__linear__list_issues', args: {} },
            { toolCallId: '2', name: 'mcp__linear__save_issue', args: {} },
        ], {
            sessionId: 'test',
            sessionKey: 'test',
            platform: 'cli',
            workingDir: '/tmp',
            currentTurn: 1,
            messageCount: 1,
            abortSignal: new AbortController().signal,
            emit: () => { },
            resultBudgetChars: 80_000,
        }, undefined, filterOpts);
        const listResult = results.find((r) => r.name === 'mcp__linear__list_issues');
        const saveResult = results.find((r) => r.name === 'mcp__linear__save_issue');
        expect(listResult?.result.ok).toBe(true);
        expect(saveResult).toBeDefined();
        expect(saveResult?.result.ok).toBe(false);
        if (saveResult && !saveResult.result.ok) {
            expect(saveResult.result.error).toContain('not permitted');
        }
    });
    it('handles double-underscore in bare tool names', () => {
        const reg = new DefaultToolRegistry();
        reg.register(makeTool('mcp__github__get__pull_request'));
        const filterOpts = {
            allowedMcpServers: ['github'],
            allowedMcpTools: { github: ['get__pull_request'] },
        };
        const defs = reg.toDefinitions(undefined, filterOpts);
        const names = defs.map((d) => d.name);
        expect(names).toContain('mcp__github__get__pull_request');
    });
});
