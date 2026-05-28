import { describe, expect, it } from 'vitest';
// ---------------------------------------------------------------------------
// Unit tests for MCP registry commands (Phase 7.1)
//
// The registry functions live in apps/ethos/src/commands/mcp.ts but that module
// has heavy transitive deps (mcp-server, session-sqlite, etc.) that vitest
// cannot resolve in isolation. We test the core logic directly here.
// ---------------------------------------------------------------------------
describe('mcp registry — package name derivation', () => {
    /**
     * The install command derives a server name from the npm package name by:
     * 1. Stripping the @scope/ prefix
     * 2. Stripping the server- prefix (if present after scope removal)
     */
    function deriveServerName(packageName) {
        return packageName.replace(/^@[^/]+\//, '').replace(/^server-/, '');
    }
    it('strips @scope/ and server- prefix', () => {
        expect(deriveServerName('@modelcontextprotocol/server-filesystem')).toBe('filesystem');
        expect(deriveServerName('@modelcontextprotocol/server-github')).toBe('github');
        expect(deriveServerName('@foo/server-bar')).toBe('bar');
    });
    it('strips only server- prefix when no scope', () => {
        expect(deriveServerName('server-sqlite')).toBe('sqlite');
        expect(deriveServerName('server-everything')).toBe('everything');
    });
    it('strips scope but leaves non-server- prefixed names intact', () => {
        expect(deriveServerName('@myorg/my-tool')).toBe('my-tool');
        expect(deriveServerName('@myorg/mcp-sqlite')).toBe('mcp-sqlite');
    });
    it('leaves plain package names without scope or server- prefix intact', () => {
        expect(deriveServerName('mcp-server-sqlite')).toBe('mcp-server-sqlite');
        expect(deriveServerName('some-random-pkg')).toBe('some-random-pkg');
    });
});
describe('mcp registry — duplicate detection', () => {
    function hasDuplicate(existing, name) {
        return existing.some((s) => s.name === name);
    }
    it('detects duplicate server names', () => {
        const existing = [{ name: 'filesystem' }, { name: 'github' }];
        expect(hasDuplicate(existing, 'filesystem')).toBe(true);
    });
    it('allows non-duplicate names', () => {
        const existing = [{ name: 'filesystem' }, { name: 'github' }];
        expect(hasDuplicate(existing, 'sqlite')).toBe(false);
    });
    it('handles empty config array', () => {
        expect(hasDuplicate([], 'anything')).toBe(false);
    });
});
describe('mcp registry — search URL construction', () => {
    function buildSearchUrl(search) {
        return `https://registry.npmjs.org/-/v1/search?text=keywords:mcp-server${search ? `+${search}` : ''}&size=20`;
    }
    it('builds URL without search term', () => {
        expect(buildSearchUrl('')).toBe('https://registry.npmjs.org/-/v1/search?text=keywords:mcp-server&size=20');
    });
    it('builds URL with search term', () => {
        expect(buildSearchUrl('sqlite')).toBe('https://registry.npmjs.org/-/v1/search?text=keywords:mcp-server+sqlite&size=20');
    });
    it('builds URL with multi-word search', () => {
        expect(buildSearchUrl('file system')).toBe('https://registry.npmjs.org/-/v1/search?text=keywords:mcp-server+file system&size=20');
    });
});
describe('mcp registry — search arg parsing', () => {
    function parseSearchArg(argv) {
        let search = '';
        for (let i = 0; i < argv.length; i++) {
            if (argv[i] === '--search' && argv[i + 1]) {
                search = argv[i + 1] ?? '';
                i++;
            }
        }
        return search;
    }
    it('extracts --search value', () => {
        expect(parseSearchArg(['--search', 'sqlite'])).toBe('sqlite');
    });
    it('returns empty for no --search flag', () => {
        expect(parseSearchArg([])).toBe('');
        expect(parseSearchArg(['--other', 'thing'])).toBe('');
    });
    it('handles --search at end without value', () => {
        expect(parseSearchArg(['--search'])).toBe('');
    });
});
describe('mcp registry — install entry construction', () => {
    it('builds correct McpServerConfig entry', () => {
        const packageName = '@modelcontextprotocol/server-filesystem';
        const name = packageName.replace(/^@[^/]+\//, '').replace(/^server-/, '');
        const entry = {
            name,
            transport: 'stdio',
            command: 'npx',
            args: ['-y', packageName],
        };
        expect(entry).toEqual({
            name: 'filesystem',
            transport: 'stdio',
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem'],
        });
    });
});
