import { describe, expect, it } from 'vitest';
import { createReadyTracker, isReadyLine } from '../run-all';
describe('run-all — aggregate ready signal', () => {
    describe('isReadyLine', () => {
        it('recognizes a valid ethos.ready JSON line', () => {
            const line = JSON.stringify({
                event: 'ethos.ready',
                command: 'gateway',
                version: 'dev',
                pid: 1234,
                timestamp: '2026-01-01T00:00:00.000Z',
            });
            expect(isReadyLine(line)).toBe(true);
        });
        it('rejects a line without the ethos.ready event', () => {
            expect(isReadyLine('{"event":"ethos.started","command":"gateway"}')).toBe(false);
            expect(isReadyLine('some random log output')).toBe(false);
            expect(isReadyLine('')).toBe(false);
        });
        it('matches when the ready line is embedded in a larger chunk', () => {
            const chunk = `pino log line\n{"event":"ethos.ready","command":"serve"}\nmore output`;
            const lines = chunk.split('\n');
            expect(lines.some(isReadyLine)).toBe(true);
        });
    });
    describe('createReadyTracker', () => {
        it('calls onAllReady once both children signal', () => {
            let callCount = 0;
            const onAllReady = () => {
                callCount++;
            };
            const track = createReadyTracker(new Set(['gateway', 'serve']), onAllReady);
            track('gateway');
            expect(callCount).toBe(0);
            track('serve');
            expect(callCount).toBe(1);
        });
        it('emits aggregate exactly once even if a child re-signals after restart', () => {
            let callCount = 0;
            const onAllReady = () => {
                callCount++;
            };
            const track = createReadyTracker(new Set(['gateway', 'serve']), onAllReady);
            track('gateway');
            track('serve');
            expect(callCount).toBe(1);
            // Simulate child restart — same name signals again
            track('gateway');
            track('serve');
            expect(callCount).toBe(1);
        });
        it('does not emit when only one of two children signals', () => {
            let callCount = 0;
            const track = createReadyTracker(new Set(['gateway', 'serve']), () => {
                callCount++;
            });
            track('gateway');
            track('gateway'); // duplicate, not the second child
            expect(callCount).toBe(0);
        });
        it('works with a single child', () => {
            let callCount = 0;
            const track = createReadyTracker(new Set(['gateway']), () => {
                callCount++;
            });
            track('gateway');
            expect(callCount).toBe(1);
        });
    });
});
