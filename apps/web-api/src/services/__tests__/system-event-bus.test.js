import { describe, expect, it, vi } from 'vitest';
import { SystemEventBus } from '../system-event-bus';
describe('SystemEventBus', () => {
    it('emits and receives system events', () => {
        const bus = new SystemEventBus();
        const handler = vi.fn();
        bus.onSystem(handler);
        bus.emitSystem({ type: 'ping' });
        expect(handler).toHaveBeenCalledWith({ type: 'ping' });
    });
    it('supports multiple listeners', () => {
        const bus = new SystemEventBus();
        const h1 = vi.fn();
        const h2 = vi.fn();
        bus.onSystem(h1);
        bus.onSystem(h2);
        bus.emitSystem({
            type: 'cron.completed',
            jobId: 'j1',
            jobName: 'test',
            ok: true,
            durationMs: 100,
        });
        expect(h1).toHaveBeenCalledOnce();
        expect(h2).toHaveBeenCalledOnce();
    });
    it('stops receiving after off', () => {
        const bus = new SystemEventBus();
        const handler = vi.fn();
        bus.onSystem(handler);
        bus.offSystem(handler);
        bus.emitSystem({ type: 'ping' });
        expect(handler).not.toHaveBeenCalled();
    });
    it('delivers typed events correctly', () => {
        const bus = new SystemEventBus();
        const handler = vi.fn();
        bus.onSystem(handler);
        bus.emitSystem({ type: 'platform.connected', platformId: 'telegram', botUsername: 'mybot' });
        expect(handler).toHaveBeenCalledWith({
            type: 'platform.connected',
            platformId: 'telegram',
            botUsername: 'mybot',
        });
        bus.emitSystem({ type: 'session.titled', sessionId: 's1', title: 'My Chat' });
        expect(handler).toHaveBeenCalledWith({
            type: 'session.titled',
            sessionId: 's1',
            title: 'My Chat',
        });
    });
});
