import { describe, expect, it } from 'vitest';
import { redactArgs, synthesizeDryRunCapResult, synthesizeDryRunResult } from '../dry-run';
describe('redactArgs', () => {
    it('passes through primitives unchanged', () => {
        expect(redactArgs(42)).toBe(42);
        expect(redactArgs(true)).toBe(true);
        expect(redactArgs(null)).toBeNull();
    });
    it('redacts known secret patterns', () => {
        const result = redactArgs('my key is ghp_abcdefghij1234567890abcdefghij123456');
        expect(result).toContain('[REDACTED:github-pat]');
    });
    it('truncates strings longer than 500 chars', () => {
        const long = 'a'.repeat(600);
        const result = redactArgs(long);
        expect(result).toContain('...[truncated,');
        expect(result.length).toBeLessThan(600);
    });
    it('deep-walks objects', () => {
        const result = redactArgs({
            safe: 'hello',
            nested: { secret: 'ghp_abcdefghij1234567890abcdefghij123456' },
        });
        const nested = result.nested;
        expect(nested.secret).toContain('[REDACTED:github-pat]');
        expect(result.safe).toBe('hello');
    });
    it('deep-walks arrays', () => {
        const result = redactArgs(['safe', 'ghp_abcdefghij1234567890abcdefghij123456']);
        expect(result[0]).toBe('safe');
        expect(result[1]).toContain('[REDACTED:github-pat]');
    });
});
describe('synthesizeDryRunResult', () => {
    it('returns ok:true stub with tool name', () => {
        const result = synthesizeDryRunResult('read_file', { path: '/tmp/foo.txt' });
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value).toContain('[dry-run]');
            expect(result.value).toContain('read_file');
            expect(result.value).toContain('/tmp/foo.txt');
        }
    });
});
describe('synthesizeDryRunCapResult', () => {
    it('returns ok:false with cap info', () => {
        const result = synthesizeDryRunCapResult('bash', 5);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error).toContain('cap (5)');
        }
    });
});
