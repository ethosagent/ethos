import { EnvSecretsResolver, InMemorySecretsResolver, MergedSecretsResolver, } from '@ethosagent/storage-fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// ---------------------------------------------------------------------------
// Helpers: save/restore process.env
// ---------------------------------------------------------------------------
let savedEnv;
beforeEach(() => {
    savedEnv = { ...process.env };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
});
afterEach(() => {
    for (const key of Object.keys(process.env)) {
        if (!(key in savedEnv)) {
            delete process.env[key];
        }
    }
    Object.assign(process.env, savedEnv);
});
// ---------------------------------------------------------------------------
// secretsBackend integration: resolver contract
// ---------------------------------------------------------------------------
describe('env-secrets integration', () => {
    it('ANTHROPIC_API_KEY in process.env resolves via MergedSecretsResolver', async () => {
        process.env.ANTHROPIC_API_KEY = 'sk-ant-integration-test';
        const file = new InMemorySecretsResolver();
        const merged = new MergedSecretsResolver({
            readers: [new EnvSecretsResolver(), file],
            writer: file,
        });
        const val = await merged.get('providers/anthropic/apiKey');
        expect(val).toBe('sk-ant-integration-test');
    });
    it('env value wins over on-disk file for the same ref (env precedence)', async () => {
        process.env.ANTHROPIC_API_KEY = 'env-wins';
        const file = new InMemorySecretsResolver();
        await file.set('providers/anthropic/apiKey', 'file-fallback');
        const merged = new MergedSecretsResolver({
            readers: [new EnvSecretsResolver(), file],
            writer: file,
        });
        const val = await merged.get('providers/anthropic/apiKey');
        expect(val).toBe('env-wins');
    });
    it('falls back to file resolver when env var is absent', async () => {
        const file = new InMemorySecretsResolver();
        await file.set('providers/anthropic/apiKey', 'file-only');
        const merged = new MergedSecretsResolver({
            readers: [new EnvSecretsResolver(), file],
            writer: file,
        });
        const val = await merged.get('providers/anthropic/apiKey');
        expect(val).toBe('file-only');
    });
    it('returns null when neither env nor file has the ref', async () => {
        const file = new InMemorySecretsResolver();
        const merged = new MergedSecretsResolver({
            readers: [new EnvSecretsResolver(), file],
            writer: file,
        });
        const val = await merged.get('providers/anthropic/apiKey');
        expect(val).toBeNull();
    });
    it('simulates secretsBackend: throws when ref not found', async () => {
        const file = new InMemorySecretsResolver();
        const merged = new MergedSecretsResolver({
            readers: [new EnvSecretsResolver(), file],
            writer: file,
        });
        // This mirrors the secretsBackend logic in packages/wiring/src/index.ts
        const secretsBackend = async (ref) => {
            const val = await merged.get(ref);
            if (val !== null)
                return val;
            throw new Error(`Secret ${ref} not found`);
        };
        await expect(secretsBackend('providers/anthropic/apiKey')).rejects.toThrow('Secret providers/anthropic/apiKey not found');
    });
    it('simulates secretsBackend: resolves when ANTHROPIC_API_KEY is set', async () => {
        process.env.ANTHROPIC_API_KEY = 'sk-ant-123';
        const file = new InMemorySecretsResolver();
        const merged = new MergedSecretsResolver({
            readers: [new EnvSecretsResolver(), file],
            writer: file,
        });
        const secretsBackend = async (ref) => {
            const val = await merged.get(ref);
            if (val !== null)
                return val;
            throw new Error(`Secret ${ref} not found`);
        };
        const result = await secretsBackend('providers/anthropic/apiKey');
        expect(result).toBe('sk-ant-123');
    });
});
