import { describe, expect, it } from 'vitest';
import { buildGatewayHeartbeat } from '../gateway';
function stubAdapter(id, healthResult) {
    return {
        id,
        displayName: id,
        canSendTyping: false,
        canEditMessage: false,
        canReact: false,
        canSendFiles: false,
        maxMessageLength: 4096,
        start: async () => { },
        stop: async () => { },
        send: async () => ({ ok: true }),
        onMessage: () => { },
        health: async () => healthResult,
    };
}
describe('buildGatewayHeartbeat', () => {
    it('includes pid, startedAt, updatedAt, and adapter statuses', async () => {
        const adapters = [
            stubAdapter('telegram:bot-1', { ok: true, latencyMs: 42 }),
            stubAdapter('slack:app-1', { ok: false }),
        ];
        const startedAt = '2026-05-20T08:00:00Z';
        const hb = await buildGatewayHeartbeat(adapters, startedAt);
        expect(hb.pid).toBe(process.pid);
        expect(hb.startedAt).toBe(startedAt);
        expect(hb.updatedAt).toBeTruthy();
        expect(hb.adapters).toEqual([
            { name: 'telegram:bot-1', ok: true },
            { name: 'slack:app-1', ok: false },
        ]);
    });
    it('marks an adapter as not-ok when health() rejects', async () => {
        const failing = stubAdapter('discord:bot', { ok: true });
        failing.health = async () => {
            throw new Error('connection refused');
        };
        const hb = await buildGatewayHeartbeat([failing], '2026-05-20T08:00:00Z');
        expect(hb.adapters).toEqual([{ name: 'discord:bot', ok: false }]);
    });
    it('marks an adapter as not-ok when health() times out', async () => {
        const hanging = stubAdapter('slow:bot', { ok: true });
        hanging.health = () => new Promise(() => { });
        const hb = await buildGatewayHeartbeat([hanging], '2026-05-20T08:00:00Z');
        expect(hb.adapters).toEqual([{ name: 'slow:bot', ok: false }]);
    }, 10_000);
    it('returns empty adapters array when no adapters are provided', async () => {
        const hb = await buildGatewayHeartbeat([], '2026-05-20T08:00:00Z');
        expect(hb.adapters).toEqual([]);
        expect(hb.pid).toBe(process.pid);
    });
});
