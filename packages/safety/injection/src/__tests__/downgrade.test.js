import { describe, expect, it } from 'vitest';
import { DOWNGRADE_REJECTION_MESSAGE, resolveDowngradedTools } from '../downgrade';
describe('resolveDowngradedTools', () => {
    it('returns the default set for `auto`', () => {
        const tools = resolveDowngradedTools('auto');
        expect(tools.has('terminal')).toBe(true);
        expect(tools.has('write_file')).toBe(true);
        expect(tools.has('browse_url')).toBe(true);
    });
    it('returns the default set for undefined (no config)', () => {
        expect(resolveDowngradedTools(undefined).has('terminal')).toBe(true);
    });
    it('returns the explicit list when provided', () => {
        const tools = resolveDowngradedTools(['only_this_tool']);
        expect(tools.has('only_this_tool')).toBe(true);
        expect(tools.has('terminal')).toBe(false);
        expect(tools.size).toBe(1);
    });
    it('returns an empty set when given an empty array', () => {
        const tools = resolveDowngradedTools([]);
        expect(tools.size).toBe(0);
    });
});
describe('DOWNGRADE_REJECTION_MESSAGE', () => {
    it('mentions the post-untrusted-read context', () => {
        expect(DOWNGRADE_REJECTION_MESSAGE).toMatch(/untrusted/i);
    });
});
