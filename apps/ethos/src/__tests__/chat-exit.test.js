import { describe, expect, it } from 'vitest';
import { formatResumeHint } from '../lib/resume-hint';
// ---------------------------------------------------------------------------
// FW-5 — resume hint formatter
// ---------------------------------------------------------------------------
describe('formatResumeHint', () => {
    it('returns null when session has no user messages', () => {
        const hint = formatResumeHint({
            sessionId: 'abc123',
            title: undefined,
            durationMs: 60_000,
            userMessageCount: 0,
            totalMessageCount: 0,
        });
        expect(hint).toBeNull();
    });
    it('includes the session ID in the resume command', () => {
        const hint = formatResumeHint({
            sessionId: 'abc123',
            title: undefined,
            durationMs: 60_000,
            userMessageCount: 2,
            totalMessageCount: 4,
        });
        expect(hint).toContain('abc123');
        expect(hint).toContain('ethos --resume');
    });
    it('includes the title when set', () => {
        const hint = formatResumeHint({
            sessionId: 'abc123',
            title: 'auth refactor',
            durationMs: 60_000,
            userMessageCount: 2,
            totalMessageCount: 4,
        });
        expect(hint).toContain('auth refactor');
    });
    it('omits title line when title is undefined', () => {
        const hint = formatResumeHint({
            sessionId: 'abc123',
            title: undefined,
            durationMs: 60_000,
            userMessageCount: 2,
            totalMessageCount: 4,
        });
        expect(hint).not.toContain('Title:');
    });
    it('includes message count', () => {
        const hint = formatResumeHint({
            sessionId: 'abc123',
            title: undefined,
            durationMs: 60_000,
            userMessageCount: 5,
            totalMessageCount: 18,
        });
        expect(hint).toContain('18');
    });
    it('includes human-readable duration', () => {
        const hint = formatResumeHint({
            sessionId: 'abc123',
            title: undefined,
            durationMs: 754_000, // 12m 34s
            userMessageCount: 2,
            totalMessageCount: 4,
        });
        expect(hint).toMatch(/12m/);
    });
});
