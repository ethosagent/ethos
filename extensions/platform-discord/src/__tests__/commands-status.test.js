import { describe, expect, it } from 'vitest';
import { handleStatus } from '../commands/status';
describe('commands/status', () => {
    const ctx = {
        binding: { type: 'personality', name: 'default' },
        defaultChannelMode: 'mention_only',
    };
    const payload = {
        commandName: 'status',
        options: {},
        channelId: 'ch1',
        userId: 'user1',
    };
    it('returns an ephemeral embed with status info', () => {
        const result = handleStatus(payload, ctx);
        expect(result.ephemeral).toBe(true);
        expect(result.embeds[0].title).toBe('Ethos Status');
    });
    it('contains session and clarify fields', () => {
        const result = handleStatus(payload, ctx);
        const fields = result.embeds[0].fields ?? [];
        expect(fields.some((f) => f.name === 'Sessions')).toBe(true);
        expect(fields.some((f) => f.name === 'Waiting Clarifies')).toBe(true);
    });
});
