import { describe, expect, it } from 'vitest';
import { buildVersionInfo } from '../version-info';
describe('buildVersionInfo', () => {
    it('returns correct shape', () => {
        const info = buildVersionInfo();
        expect(info.name).toBe('@ethosagent/cli');
        expect(typeof info.version).toBe('string');
        expect(info.node).toBe(process.version);
        expect(typeof info.platform).toBe('string');
        expect(typeof info.arch).toBe('string');
        expect(info.supportedProviders).toContain('anthropic');
        expect(info.supportedProviders).toContain('openai');
        expect(info.supportedProviders).toContain('azure');
        expect(info.supportedChannels).toContain('telegram');
        expect(info.supportedChannels).toContain('slack');
        expect(info.supportedChannels).toContain('discord');
        expect(info.supportedChannels).toContain('email');
        expect(info.supportedChannels).not.toContain('whatsapp');
        expect(typeof info.managedMode).toBe('boolean');
        expect(typeof info.ethosDir).toBe('string');
    });
    it('reflects ETHOS_MANAGED env var', () => {
        const orig = process.env.ETHOS_MANAGED;
        try {
            process.env.ETHOS_MANAGED = '1';
            expect(buildVersionInfo().managedMode).toBe(true);
            delete process.env.ETHOS_MANAGED;
            expect(buildVersionInfo().managedMode).toBe(false);
        }
        finally {
            if (orig !== undefined)
                process.env.ETHOS_MANAGED = orig;
            else
                delete process.env.ETHOS_MANAGED;
        }
    });
    it('JSON output parses correctly', () => {
        const info = buildVersionInfo();
        const json = JSON.stringify(info);
        const parsed = JSON.parse(json);
        expect(parsed.name).toBe('@ethosagent/cli');
        expect(parsed.supportedProviders).toEqual(info.supportedProviders);
    });
});
