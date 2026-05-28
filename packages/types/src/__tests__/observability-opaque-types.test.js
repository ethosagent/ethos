// Mechanical gate enforcing that `EventCategory` and `TraceKind` in
// `@ethosagent/types` stay opaque (i.e. `string`). Consumer-specific
// vocabulary lives in adapter modules outside this package.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
const SOURCE = join(import.meta.dirname, '..', 'observability.ts');
function extractTypeAlias(src, name) {
    const start = src.indexOf(`export type ${name}`);
    if (start < 0)
        throw new Error(`type ${name} not found`);
    const eq = src.indexOf('=', start);
    const semi = src.indexOf(';', eq);
    return src.slice(eq + 1, semi).trim();
}
describe('observability opaque types', () => {
    const src = readFileSync(SOURCE, 'utf-8');
    it('EventCategory has no literal-string members', () => {
        const body = extractTypeAlias(src, 'EventCategory');
        expect(body, `EventCategory must be opaque (string), got: ${body}`).not.toMatch(/['"]/);
        expect(body).toBe('string');
    });
    it('TraceKind has no literal-string members', () => {
        const body = extractTypeAlias(src, 'TraceKind');
        expect(body, `TraceKind must be opaque (string), got: ${body}`).not.toMatch(/['"]/);
        expect(body).toBe('string');
    });
});
