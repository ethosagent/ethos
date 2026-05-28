import { join } from 'node:path';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigRepository } from '../../repositories/config.repository';
const DATA = '/data';
describe('ConfigRepository', () => {
    let storage;
    let repo;
    beforeEach(() => {
        storage = new InMemoryStorage();
        repo = new ConfigRepository({ dataDir: DATA, storage });
    });
    it('preserves dotted passthrough keys on read and write', async () => {
        await storage.mkdir(DATA);
        await storage.write(join(DATA, 'config.yaml'), `${[
            'provider: anthropic',
            'telegram.bots.0.token: 123:ABC',
            'telegram.bots.0.bind.type: personality',
            'telegram.bots.0.bind.name: researcher',
            'telegram.bots.1.token: 456:DEF',
            'telegram.bots.1.bind.type: team',
            'telegram.bots.1.bind.name: eng',
        ].join('\n')}\n`);
        const config = await repo.read();
        expect(config?.passthrough['telegram.bots.0.token']).toBe('123:ABC');
        expect(config?.passthrough['telegram.bots.0.bind.type']).toBe('personality');
        expect(config?.passthrough['telegram.bots.0.bind.name']).toBe('researcher');
        expect(config?.passthrough['telegram.bots.1.token']).toBe('456:DEF');
        // Update an unrelated field — dotted keys must survive
        await repo.update({ model: 'claude-opus-4-7' });
        const yaml = await storage.read(join(DATA, 'config.yaml'));
        expect(yaml).toContain('telegram.bots.0.token: "123:ABC"');
        expect(yaml).toContain('telegram.bots.1.bind.name: eng');
    });
    it('reads providers.N.field lines into a providers array', async () => {
        await storage.mkdir(DATA);
        await storage.write(join(DATA, 'config.yaml'), [
            'provider: anthropic',
            'model: claude-opus-4-7',
            'apiKey: sk-ant-primary',
            'providers.0.provider: anthropic',
            'providers.0.apiKey: sk-ant-primary',
            'providers.0.model: claude-opus-4-7',
            'providers.1.provider: openrouter',
            'providers.1.apiKey: sk-or-fallback',
            'providers.1.model: gpt-4',
            'providers.1.baseUrl: https://openrouter.ai/api/v1',
        ].join('\n'));
        const config = await repo.read();
        expect(config?.providers).toHaveLength(2);
        expect(config?.providers[0]).toEqual({
            provider: 'anthropic',
            apiKey: 'sk-ant-primary',
            model: 'claude-opus-4-7',
        });
        expect(config?.providers[1]).toEqual({
            provider: 'openrouter',
            apiKey: 'sk-or-fallback',
            model: 'gpt-4',
            baseUrl: 'https://openrouter.ai/api/v1',
        });
        // Verify they don't leak into passthrough
        expect(config?.passthrough['providers.0.provider']).toBeUndefined();
        expect(config?.passthrough['providers.1.apiKey']).toBeUndefined();
    });
    it('round-trips providers through write then read', async () => {
        await repo.update({
            provider: 'anthropic',
            model: 'claude-opus-4-7',
            apiKey: 'sk-ant-primary',
            providers: [
                { provider: 'anthropic', apiKey: 'sk-ant-primary', model: 'claude-opus-4-7' },
                {
                    provider: 'openrouter',
                    apiKey: 'sk-or-fallback',
                    model: 'gpt-4',
                    baseUrl: 'https://openrouter.ai/api/v1',
                },
            ],
        });
        const config = await repo.read();
        expect(config?.providers).toHaveLength(2);
        expect(config?.providers[0]?.provider).toBe('anthropic');
        expect(config?.providers[0]?.model).toBe('claude-opus-4-7');
        expect(config?.providers[1]?.provider).toBe('openrouter');
        expect(config?.providers[1]?.baseUrl).toBe('https://openrouter.ai/api/v1');
        // Verify the raw YAML has the indexed keys
        const yaml = await storage.read(join(DATA, 'config.yaml'));
        expect(yaml).toContain('providers.0.provider: anthropic');
        expect(yaml).toContain('providers.1.provider: openrouter');
        expect(yaml).toContain('providers.1.baseUrl: "https://openrouter.ai/api/v1"');
    });
    it('update with providers replaces the entire array', async () => {
        await repo.update({
            providers: [
                { provider: 'anthropic', apiKey: 'sk-ant-1' },
                { provider: 'openrouter', apiKey: 'sk-or-1' },
            ],
        });
        // Now replace with a single provider
        await repo.update({
            providers: [{ provider: 'ollama', model: 'llama3' }],
        });
        const config = await repo.read();
        expect(config?.providers).toHaveLength(1);
        expect(config?.providers[0]?.provider).toBe('ollama');
        // Old providers should be gone
        const yaml = await storage.read(join(DATA, 'config.yaml'));
        expect(yaml).not.toContain('openrouter');
    });
    it('deletePassthroughKeys removes dotted keys', async () => {
        await repo.update({
            passthrough: {
                'telegram.bots.0.token': 'tok',
                'telegram.bots.0.bind.type': 'personality',
                'telegram.bots.0.bind.name': 'researcher',
                telegramToken: 'old',
            },
        });
        await repo.deletePassthroughKeys([
            'telegram.bots.0.token',
            'telegram.bots.0.bind.type',
            'telegram.bots.0.bind.name',
        ]);
        const config = await repo.read();
        expect(config?.passthrough['telegram.bots.0.token']).toBeUndefined();
        expect(config?.passthrough.telegramToken).toBe('old');
    });
});
