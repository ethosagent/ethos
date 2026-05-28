import { describe, expect, it } from 'vitest';
import { getPreset, MCP_PRESETS } from '../presets';
describe('MCP_PRESETS', () => {
    it('every preset has all required fields', () => {
        for (const [key, preset] of Object.entries(MCP_PRESETS)) {
            expect(preset.name).toBe(key);
            expect(typeof preset.description).toBe('string');
            expect(preset.description.length).toBeGreaterThan(0);
            expect(typeof preset.command).toBe('string');
            expect(preset.command.length).toBeGreaterThan(0);
            expect(Array.isArray(preset.args)).toBe(true);
            expect(Array.isArray(preset.envVars)).toBe(true);
        }
    });
    it('contains at least the five standard presets', () => {
        const keys = Object.keys(MCP_PRESETS);
        expect(keys).toContain('filesystem');
        expect(keys).toContain('git');
        expect(keys).toContain('sqlite');
        expect(keys).toContain('fetch');
        expect(keys).toContain('memory');
    });
});
describe('getPreset', () => {
    it('returns the preset for a known name', () => {
        const preset = getPreset('filesystem');
        expect(preset).toBeDefined();
        expect(preset?.name).toBe('filesystem');
        expect(preset?.command).toBe('npx');
        expect(preset?.args).toContain('@modelcontextprotocol/server-filesystem');
    });
    it('returns undefined for an unknown name', () => {
        expect(getPreset('does-not-exist')).toBeUndefined();
    });
    it('returns undefined for empty string', () => {
        expect(getPreset('')).toBeUndefined();
    });
});
