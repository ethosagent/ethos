import { describe, expect, it, vi } from 'vitest';
import { isPidAlive, runtimeHealth } from '../team-runtime';
describe('team-runtime helpers', () => {
    it('runtimeHealth returns missing when runtime is null', () => {
        expect(runtimeHealth(null)).toBe('missing');
    });
    it('isPidAlive returns true when process.kill(pid, 0) succeeds', () => {
        const spy = vi.spyOn(process, 'kill').mockImplementation((() => true));
        expect(isPidAlive(123)).toBe(true);
        expect(spy).toHaveBeenCalledWith(123, 0);
        spy.mockRestore();
    });
    it('isPidAlive returns true on EPERM', () => {
        const err = Object.assign(new Error('not permitted'), { code: 'EPERM' });
        const spy = vi.spyOn(process, 'kill').mockImplementation((() => {
            throw err;
        }));
        expect(isPidAlive(123)).toBe(true);
        spy.mockRestore();
    });
    it('isPidAlive returns false on ESRCH', () => {
        const err = Object.assign(new Error('missing'), { code: 'ESRCH' });
        const spy = vi.spyOn(process, 'kill').mockImplementation((() => {
            throw err;
        }));
        expect(isPidAlive(123)).toBe(false);
        spy.mockRestore();
    });
});
