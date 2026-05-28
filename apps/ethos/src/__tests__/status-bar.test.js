import { describe, expect, it } from 'vitest';
import { pickLayout, renderStatusBar, thresholdFor } from '../lib/status-bar';
describe('FW-1 status bar layout', () => {
    it('picks full layout at ≥76 columns', () => {
        expect(pickLayout(76)).toBe('full');
        expect(pickLayout(120)).toBe('full');
    });
    it('picks compact layout at 52–75 columns', () => {
        expect(pickLayout(52)).toBe('compact');
        expect(pickLayout(70)).toBe('compact');
        expect(pickLayout(75)).toBe('compact');
    });
    it('picks minimal layout below 52 columns', () => {
        expect(pickLayout(51)).toBe('minimal');
        expect(pickLayout(40)).toBe('minimal');
    });
});
describe('FW-1 status bar render', () => {
    const base = { model: 'claude-opus-4-7', contextTokens: 12_400, contextMax: 200_000 };
    it('full layout renders model · tokens · bar · percent · duration', () => {
        const r = renderStatusBar({ ...base, elapsedSecs: 900, columns: 80 });
        expect(r.layout).toBe('full');
        expect(r.text).toContain('claude-opus-4-7');
        expect(r.text).toContain('12.4K/200.0K');
        expect(r.text).toMatch(/\[█+░+\]/);
        expect(r.text).toContain('6%');
        expect(r.text).toContain('15m');
    });
    it('compact layout drops the bar but keeps percent', () => {
        const r = renderStatusBar({ ...base, elapsedSecs: 900, columns: 70 });
        expect(r.layout).toBe('compact');
        expect(r.text).not.toMatch(/\[█+░+\]/);
        expect(r.text).toContain('6%');
        expect(r.text).toContain('12.4K/200.0K');
    });
    it('minimal layout shows only model + duration', () => {
        const r = renderStatusBar({ ...base, elapsedSecs: 900, columns: 50 });
        expect(r.layout).toBe('minimal');
        expect(r.text).toContain('claude-opus-4-7');
        expect(r.text).toContain('15m');
        expect(r.text).not.toContain('%');
        expect(r.text).not.toContain('200');
    });
    it('truncates model names longer than 26 chars', () => {
        const r = renderStatusBar({
            model: 'extremely-long-model-name-that-exceeds-twenty-six',
            contextTokens: 0,
            contextMax: 200_000,
            elapsedSecs: 1,
            columns: 120,
        });
        expect(r.text).toContain('…');
        // Truncated form starts with first 25 chars, ends with ellipsis.
        expect(r.text).toContain('extremely-long-model-name');
    });
    it('formats duration in s / m / h', () => {
        expect(renderStatusBar({ ...base, elapsedSecs: 5, columns: 80 }).text).toContain('5s');
        expect(renderStatusBar({ ...base, elapsedSecs: 60, columns: 80 }).text).toContain('1m');
        expect(renderStatusBar({ ...base, elapsedSecs: 3600, columns: 80 }).text).toContain('1h');
        expect(renderStatusBar({ ...base, elapsedSecs: 3660, columns: 80 }).text).toContain('1h1m');
    });
});
describe('FW-1 threshold transitions', () => {
    it('green below 50%', () => {
        expect(thresholdFor(0)).toBe('green');
        expect(thresholdFor(49.9)).toBe('green');
    });
    it('yellow at 50%, orange at 80%, red at 95%', () => {
        expect(thresholdFor(50)).toBe('yellow');
        expect(thresholdFor(79.9)).toBe('yellow');
        expect(thresholdFor(80)).toBe('orange');
        expect(thresholdFor(94.9)).toBe('orange');
        expect(thresholdFor(95)).toBe('red');
        expect(thresholdFor(100)).toBe('red');
    });
    it('threshold derived from contextTokens / contextMax', () => {
        const r = renderStatusBar({
            model: 'm',
            contextTokens: 100_000,
            contextMax: 200_000,
            elapsedSecs: 0,
            columns: 80,
        });
        expect(r.threshold).toBe('yellow');
    });
});
describe('FW-1 column counts', () => {
    it('full layout at 80 cols stays under 80 columns', () => {
        const r = renderStatusBar({
            model: 'claude-opus-4-7',
            contextTokens: 12_400,
            contextMax: 200_000,
            elapsedSecs: 900,
            columns: 80,
        });
        expect(r.columns).toBeLessThanOrEqual(80);
    });
    it('compact layout at 70 cols stays under 70 columns', () => {
        const r = renderStatusBar({
            model: 'claude-opus-4-7',
            contextTokens: 12_400,
            contextMax: 200_000,
            elapsedSecs: 900,
            columns: 70,
        });
        expect(r.columns).toBeLessThanOrEqual(70);
    });
    it('minimal layout at 50 cols stays under 50 columns', () => {
        const r = renderStatusBar({
            model: 'claude-opus-4-7',
            contextTokens: 12_400,
            contextMax: 200_000,
            elapsedSecs: 900,
            columns: 50,
        });
        expect(r.columns).toBeLessThanOrEqual(50);
    });
});
