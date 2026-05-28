import { describe, expect, it } from 'vitest';
describe('PersonalityConfig safety.observability schema', () => {
    it('safety field is optional on PersonalityConfig', () => {
        const cfg = {
            id: 'test',
            name: 'Test',
            model: 'claude-sonnet-4-6',
        };
        expect(cfg.safety).toBeUndefined();
    });
    it('valid observability config shape', () => {
        const obs = {
            storeToolArgs: 'redacted',
            storeToolBodies: 'none',
            storeLlmPayloads: 'metadata',
            redactPatterns: ['SECRET-[A-Z0-9]+'],
        };
        expect(obs.storeToolArgs).toBe('redacted');
        expect(obs.redactPatterns).toHaveLength(1);
    });
    it('PersonalitySafetyConfig accepts observability sub-block', () => {
        const safety = {
            observability: { storeToolBodies: 'full' },
        };
        expect(safety.observability?.storeToolBodies).toBe('full');
    });
    it('partial observability override is valid', () => {
        const cfg = {
            id: 'test',
            name: 'Test',
            model: 'claude-sonnet-4-6',
            safety: { observability: { storeToolBodies: 'redacted' } },
        };
        expect(cfg.safety?.observability?.storeToolBodies).toBe('redacted');
        expect(cfg.safety?.observability?.storeToolArgs).toBeUndefined();
    });
});
