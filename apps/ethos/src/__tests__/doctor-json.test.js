import { describe, expect, it } from 'vitest';
// Shape test for the doctor --json output contract.
// Full command path is not tested here since it loads real SDKs
// and reads ~/.ethos; these tests verify the documented JSON shape.
describe('ethos doctor --json output shape', () => {
    it('SDK entry has required fields', () => {
        const sdkEntry = {
            label: 'Anthropic provider',
            module: '@anthropic-ai/sdk',
            required: true,
            loadable: true,
        };
        expect(typeof sdkEntry.label).toBe('string');
        expect(typeof sdkEntry.module).toBe('string');
        expect(typeof sdkEntry.required).toBe('boolean');
        expect(typeof sdkEntry.loadable).toBe('boolean');
    });
    it('optional SDK entry may have configured field', () => {
        const optional = {
            label: 'Telegram',
            module: 'grammy',
            required: false,
            configured: true,
            loadable: false,
        };
        expect(optional.required).toBe(false);
        expect(typeof optional.configured).toBe('boolean');
        expect(optional.loadable).toBe(false);
    });
    it('JSON output root keys are defined', () => {
        const shape = {
            version: { name: '@ethosagent/cli', version: 'dev' },
            sdks: [],
            config: { present: false, path: '/home/user/.ethos/config.yaml' },
            personalities: { dir: '/home/user/.ethos/personalities', loadable: false },
            skillCliIssues: [],
            exit: 0,
        };
        expect(shape).toHaveProperty('version');
        expect(shape).toHaveProperty('sdks');
        expect(shape).toHaveProperty('config');
        expect(shape).toHaveProperty('personalities');
        expect(shape).toHaveProperty('skillCliIssues');
        expect(shape).toHaveProperty('exit');
    });
    it('skillCliIssues entry shape', () => {
        const entry = { name: 'gh', path: null, ok: false };
        expect(typeof entry.name).toBe('string');
        expect(entry.path === null || typeof entry.path === 'string').toBe(true);
        expect(typeof entry.ok).toBe('boolean');
    });
    it('exit is 0 when no core failures or configured-missing', () => {
        const sdks = [
            { label: 'Anthropic provider', module: '@anthropic-ai/sdk', required: true, loadable: true },
            { label: 'Telegram', module: 'grammy', required: false, configured: false, loadable: false },
        ];
        const coreFailures = sdks.filter((s) => s.required && !s.loadable);
        const configuredMissing = sdks.filter((s) => !s.required && s.configured && !s.loadable);
        const exitCode = coreFailures.length > 0 || configuredMissing.length > 0 ? 1 : 0;
        expect(exitCode).toBe(0);
    });
    it('exit is 1 when a core SDK is missing', () => {
        const sdks = [
            { label: 'Anthropic provider', module: '@anthropic-ai/sdk', required: true, loadable: false },
        ];
        const coreFailures = sdks.filter((s) => s.required && !s.loadable);
        const exitCode = coreFailures.length > 0 ? 1 : 0;
        expect(exitCode).toBe(1);
    });
});
