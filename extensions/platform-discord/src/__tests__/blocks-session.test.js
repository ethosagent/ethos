import { describe, expect, it } from 'vitest';
import { sessionEmbed } from '../blocks/session';
describe('blocks/session', () => {
    it('builds a session embed with required fields', () => {
        const result = sessionEmbed({
            sessionKey: 'discord:bot123:ch456',
            turnCount: 5,
        });
        expect(result.title).toBe('Session Info');
        const fields = result.fields ?? [];
        expect(fields.some((f) => f.name === 'Session' && f.value.includes('discord:bot123:ch456'))).toBe(true);
        expect(fields.some((f) => f.name === 'Turns' && f.value === '5')).toBe(true);
    });
    it('includes optional startedAt field', () => {
        const result = sessionEmbed({
            sessionKey: 'key',
            turnCount: 1,
            startedAt: '2024-01-15T10:00:00Z',
        });
        const fields = result.fields ?? [];
        expect(fields.some((f) => f.name === 'Started')).toBe(true);
    });
    it('includes optional personality field', () => {
        const result = sessionEmbed({
            sessionKey: 'key',
            turnCount: 1,
            personality: 'Atlas',
        });
        const fields = result.fields ?? [];
        expect(fields.some((f) => f.name === 'Personality' && f.value === 'Atlas')).toBe(true);
    });
});
