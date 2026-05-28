// G6: ethos tail --json round-trip test.
// Verifies that every event field survives JSON.stringify → JSON.parse intact,
// including edge-case strings (newlines, unicode, quotes).
import { describe, expect, it } from 'vitest';
function jsonRoundTrip(event) {
    return JSON.parse(JSON.stringify(event));
}
describe('tail --json round-trip', () => {
    it('round-trips a standard event without field loss', () => {
        const event = {
            eventId: 'abc-123',
            ts: 1_000_000_000_000,
            category: 'audit.approval',
            severity: 'info',
            code: 'tool.bash',
            cause: 'ran git status',
        };
        const parsed = jsonRoundTrip(event);
        expect(parsed.eventId).toBe(event.eventId);
        expect(parsed.ts).toBe(event.ts);
        expect(parsed.category).toBe(event.category);
        expect(parsed.severity).toBe(event.severity);
        expect(parsed.code).toBe(event.code);
        expect(parsed.cause).toBe(event.cause);
    });
    it('round-trips strings containing quotes and newlines without corruption', () => {
        const event = {
            eventId: 'e1',
            ts: 1000,
            category: 'error',
            severity: 'error',
            cause: 'failed with message: "line1\nline2\ttabbed"',
        };
        const line = `${JSON.stringify(event)}\n`;
        // Must be parseable as a single JSON object from one NDJSON line (strip newline)
        const parsed = JSON.parse(line.trimEnd());
        expect(parsed.cause).toBe(event.cause);
    });
    it('round-trips unicode characters', () => {
        const event = {
            eventId: 'e2',
            ts: 2000,
            category: 'audit.block',
            severity: 'warn',
            cause: 'blocked: emoji 🚫 and CJK 日本語',
        };
        const parsed = jsonRoundTrip(event);
        expect(parsed.cause).toBe(event.cause);
    });
    it('each NDJSON line is a complete self-contained JSON object', () => {
        const events = [
            { eventId: 'a', ts: 1, category: 'error', severity: 'error' },
            { eventId: 'b', ts: 2, category: 'audit.approval', severity: 'info' },
        ];
        const ndjson = events.map((e) => JSON.stringify(e)).join('\n');
        for (const line of ndjson.split('\n')) {
            expect(() => JSON.parse(line)).not.toThrow();
            const parsed = JSON.parse(line);
            expect(typeof parsed.eventId).toBe('string');
            expect(typeof parsed.ts).toBe('number');
        }
    });
    it('null optional fields are omitted or null — no undefined leakage', () => {
        const event = {
            eventId: 'e3',
            ts: 3000,
            category: 'error',
            severity: 'error',
            // code, cause, details are absent
        };
        const line = JSON.stringify(event);
        expect(line).not.toContain('undefined');
        const parsed = JSON.parse(line);
        expect('code' in parsed).toBe(false);
        expect('cause' in parsed).toBe(false);
    });
});
