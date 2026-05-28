import { describe, expect, it } from 'vitest';
import { stripAnsiEscapes } from '../sanitize-output';
describe('stripAnsiEscapes', () => {
    it('returns plain text unchanged', () => {
        expect(stripAnsiEscapes('hello world')).toBe('hello world');
    });
    it('strips basic CSI color codes', () => {
        expect(stripAnsiEscapes('\x1b[31mred\x1b[0m')).toBe('red');
    });
    it('strips CSI cursor movement', () => {
        expect(stripAnsiEscapes('\x1b[2J\x1b[Hstart')).toBe('start');
    });
    it('strips CSI private mode: hide cursor (?25l)', () => {
        expect(stripAnsiEscapes('\x1b[?25lhidden cursor\x1b[?25h')).toBe('hidden cursor');
    });
    it('strips CSI private mode: bracketed paste (?2004h)', () => {
        expect(stripAnsiEscapes('\x1b[?2004hpasted\x1b[?2004l')).toBe('pasted');
    });
    it('strips OSC sequence terminated with BEL (title change)', () => {
        expect(stripAnsiEscapes('\x1b]0;malicious title\x07visible')).toBe('visible');
    });
    it('strips OSC sequence terminated with ST (ESC\\) — hyperlink', () => {
        const hyperlink = '\x1b]8;;https://evil.com\x1b\\click\x1b]8;;\x1b\\';
        expect(stripAnsiEscapes(hyperlink)).toBe('click');
    });
    it('strips character set selection (G0)', () => {
        expect(stripAnsiEscapes('\x1b(Btext')).toBe('text');
    });
    it('strips single-character escape sequences', () => {
        // ESC D (index), ESC M (reverse index), ESC 7 (save cursor)
        expect(stripAnsiEscapes('\x1bD\x1bM\x1b7hello\x1b8')).toBe('hello');
    });
    it('strips tilde-terminated CSI sequences', () => {
        // e.g. \x1b[200~ (bracketed paste start marker)
        expect(stripAnsiEscapes('\x1b[200~pasted text\x1b[201~')).toBe('pasted text');
    });
    it('handles mixed escape sequences in one string', () => {
        const input = '\x1b[?25l\x1b]0;title\x07\x1b[1;32mgreen\x1b[0m\x1b[?25h';
        expect(stripAnsiEscapes(input)).toBe('green');
    });
    it('strips clear screen (CSI 2J)', () => {
        expect(stripAnsiEscapes('\x1b[2Jcontent')).toBe('content');
    });
    it('handles residues from multi-pass stripping', () => {
        // After stripping \x1b[31m, the leading \x1b[ from the first fragment
        // could combine with subsequent text to form a new escape sequence.
        // The fixpoint loop catches this.
        const crafted = '\x1b[\x1b[31m32minjected';
        const result = stripAnsiEscapes(crafted);
        expect(result).not.toContain('\x1b');
        expect(result).toBe('injected');
    });
    it('converges on pathological input within iteration cap', () => {
        // Even deeply nested/overlapping fragments should not cause infinite loops
        const nested = '\x1b[\x1b[\x1b[31m32m0mvisible';
        const result = stripAnsiEscapes(nested);
        expect(result).not.toContain('\x1b');
    });
});
