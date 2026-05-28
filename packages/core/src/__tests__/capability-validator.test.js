import { describe, expect, it } from 'vitest';
import { validateRegistration } from '../capability-validator';
import { DefaultToolRegistry } from '../tool-registry';
function makeTool(overrides = {}) {
    return {
        name: 'test-tool',
        description: 'a test tool',
        schema: {},
        capabilities: {},
        execute: async () => ({ ok: true, value: '' }),
        ...overrides,
    };
}
function makePersonality(overrides = {}) {
    return {
        id: 'test',
        name: 'Test',
        ...overrides,
    };
}
describe('validateRegistration', () => {
    it('no capabilities field → empty errors', () => {
        const tool = makeTool();
        const personality = makePersonality();
        expect(validateRegistration(tool, personality)).toEqual([]);
    });
    it('empty capabilities → empty errors', () => {
        const tool = makeTool({ capabilities: {} });
        const personality = makePersonality();
        expect(validateRegistration(tool, personality)).toEqual([]);
    });
    it('network host in personality allow → passes', () => {
        const tool = makeTool({
            capabilities: { network: { allowedHosts: ['api.github.com'] } },
        });
        const personality = makePersonality({
            safety: { network: { allow: ['api.github.com'] } },
        });
        expect(validateRegistration(tool, personality)).toEqual([]);
    });
    it('network host NOT in personality allow → error', () => {
        const tool = makeTool({
            name: 'net-tool',
            capabilities: { network: { allowedHosts: ['evil.com'] } },
        });
        const personality = makePersonality({
            safety: { network: { allow: ['api.github.com'] } },
        });
        const errors = validateRegistration(tool, personality);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatchObject({
            tool: 'net-tool',
            capability: 'network',
        });
    });
    it('network wildcard * always passes', () => {
        const tool = makeTool({
            capabilities: { network: { allowedHosts: ['*'] } },
        });
        const personality = makePersonality();
        expect(validateRegistration(tool, personality)).toEqual([]);
    });
    it('network host covered by personality subdomain wildcard → passes', () => {
        const tool = makeTool({
            capabilities: { network: { allowedHosts: ['api.github.com'] } },
        });
        const personality = makePersonality({
            safety: { network: { allow: ['*.github.com'] } },
        });
        expect(validateRegistration(tool, personality)).toEqual([]);
    });
    it('personality wildcard * covers all hosts', () => {
        const tool = makeTool({
            capabilities: { network: { allowedHosts: ['anything.example.com'] } },
        });
        const personality = makePersonality({
            safety: { network: { allow: ['*'] } },
        });
        expect(validateRegistration(tool, personality)).toEqual([]);
    });
    it('network with no personality allow list → open mode, no error', () => {
        // Mirrors resolveCapabilities: a personality without an explicit
        // `safety.network.allow` is in open mode. The validator must not
        // false-positive here — existing personalities that don't bother
        // setting an allow list would otherwise refuse to boot when they
        // include any tool that declares specific hosts.
        const tool = makeTool({
            name: 'net-tool',
            capabilities: { network: { allowedHosts: ['api.github.com'] } },
        });
        const personality = makePersonality();
        expect(validateRegistration(tool, personality)).toEqual([]);
    });
    it('network with empty personality allow list → open mode, no error', () => {
        const tool = makeTool({
            name: 'net-tool',
            capabilities: { network: { allowedHosts: ['api.github.com'] } },
        });
        const personality = makePersonality({
            safety: { network: { allow: [] } },
        });
        expect(validateRegistration(tool, personality)).toEqual([]);
    });
    it('fs_reach read "from-personality" always passes', () => {
        const tool = makeTool({
            capabilities: { fs_reach: { read: 'from-personality' } },
        });
        const personality = makePersonality();
        expect(validateRegistration(tool, personality)).toEqual([]);
    });
    it('fs_reach explicit paths covered by personality → passes', () => {
        const tool = makeTool({
            capabilities: { fs_reach: { read: ['/data/files'] } },
        });
        const personality = makePersonality({
            fs_reach: { read: ['/data'] },
        });
        expect(validateRegistration(tool, personality)).toEqual([]);
    });
    it('fs_reach explicit paths NOT covered → error', () => {
        const tool = makeTool({
            name: 'fs-tool',
            capabilities: { fs_reach: { read: ['/etc'] } },
        });
        const personality = makePersonality({
            fs_reach: { read: ['/data'] },
        });
        const errors = validateRegistration(tool, personality);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatchObject({
            tool: 'fs-tool',
            capability: 'fs_reach.read',
        });
    });
    it('fs_reach write paths validated separately', () => {
        const tool = makeTool({
            name: 'fs-tool',
            capabilities: { fs_reach: { write: ['/secret'] } },
        });
        const personality = makePersonality({
            fs_reach: { write: ['/out'] },
        });
        const errors = validateRegistration(tool, personality);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatchObject({
            tool: 'fs-tool',
            capability: 'fs_reach.write',
        });
    });
    it('multiple errors collected', () => {
        const tool = makeTool({
            name: 'multi-tool',
            capabilities: {
                network: { allowedHosts: ['bad.com'] },
                fs_reach: { read: ['/etc'], write: ['/secret'] },
            },
        });
        const personality = makePersonality({
            safety: { network: { allow: ['good.com'] } },
            fs_reach: { read: ['/data'], write: ['/out'] },
        });
        const errors = validateRegistration(tool, personality);
        expect(errors).toHaveLength(3);
        const capabilities = errors.map((e) => e.capability).sort();
        expect(capabilities).toEqual(['fs_reach.read', 'fs_reach.write', 'network']);
    });
    it('storage always passes', () => {
        const tool = makeTool({
            capabilities: { storage: { scope: 'session', kind: 'kv' } },
        });
        const personality = makePersonality();
        expect(validateRegistration(tool, personality)).toEqual([]);
    });
    it('process always passes', () => {
        const tool = makeTool({
            capabilities: { process: { allowedBinaries: ['bash'] } },
        });
        const personality = makePersonality();
        expect(validateRegistration(tool, personality)).toEqual([]);
    });
});
describe('DefaultToolRegistry.validateToolsForPersonality', () => {
    it('collects errors from all tools reachable for the personality', () => {
        const registry = new DefaultToolRegistry();
        registry.register(makeTool({
            name: 'tool-a',
            capabilities: { network: { allowedHosts: ['bad-a.com'] } },
        }));
        registry.register(makeTool({
            name: 'tool-b',
            capabilities: { fs_reach: { read: ['/etc'] } },
        }));
        // Non-empty allow list = restricted mode; bad-a.com is not covered.
        const personality = makePersonality({
            safety: { network: { allow: ['good.com'] } },
            fs_reach: { read: ['/data'] },
        });
        const errors = registry.validateToolsForPersonality(personality);
        expect(errors).toHaveLength(2);
        const toolNames = errors.map((e) => e.tool).sort();
        expect(toolNames).toEqual(['tool-a', 'tool-b']);
    });
    it('skips tools not reachable for the personality (toolset filter)', () => {
        const registry = new DefaultToolRegistry();
        registry.register(makeTool({
            name: 'tool-a',
            capabilities: { network: { allowedHosts: ['bad-a.com'] } },
        }));
        registry.register(makeTool({
            name: 'tool-b',
            capabilities: { fs_reach: { read: ['/etc'] } },
        }));
        const personality = makePersonality({
            toolset: ['tool-b'],
            safety: { network: { allow: ['good.com'] } },
            fs_reach: { read: ['/data'] },
        });
        const errors = registry.validateToolsForPersonality(personality);
        expect(errors).toHaveLength(1);
        expect(errors[0]?.tool).toBe('tool-b');
    });
});
