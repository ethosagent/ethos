// Mechanical schema-freeze gate for `Storage`.
//
// ARCHITECTURE.md §VII lists `Storage` as a frozen schema with a
// "Method-shape test" drift gate; this is that test. The Storage contract
// guards the personality filesystem boundary (Law 7) — adding, removing,
// or renaming a method without owner approval is a constitutional change.
//
// To extend the contract:
//   1. Owner approval per §VII (any two repository maintainers).
//   2. CHANGELOG entry naming the schema bump.
//   3. Update the expected method list below in the same commit.
//
// Mirrors the `memory-method-count` gate pattern.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
const SOURCE = join(import.meta.dirname, '..', 'storage.ts');
function extractStorageMethods(src) {
    // Match the exact `Storage` interface, not StorageWriteOptions /
    // StorageRemoveOptions / StorageDirEntry. The trailing `{` is what
    // disambiguates: the suffix-typed names always have a character before
    // the open brace.
    const match = src.match(/export interface Storage\s*\{/);
    if (!match || match.index === undefined)
        throw new Error('Storage interface not found');
    const startIdx = match.index;
    const openIdx = src.indexOf('{', startIdx);
    if (openIdx < 0)
        throw new Error('Storage opening brace not found');
    let depth = 1;
    let i = openIdx + 1;
    let body = '';
    while (i < src.length && depth > 0) {
        const ch = src[i];
        if (ch === '{' || ch === '<' || ch === '(' || ch === '[')
            depth++;
        else if (ch === '}' || ch === '>' || ch === ')' || ch === ']') {
            depth--;
            if (depth === 0)
                break;
        }
        body += ch;
        i++;
    }
    // Strip block + line comments so commented-out methods don't count.
    const stripped = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    // Method declarations are `name(...): Promise<...>;` at depth 0.
    const methods = [];
    let d = 0;
    let cursor = 0;
    while (cursor < stripped.length) {
        const ch = stripped[cursor];
        if (ch === '(' || ch === '{' || ch === '<' || ch === '[') {
            d++;
            cursor++;
            continue;
        }
        if (ch === ')' || ch === '}' || ch === '>' || ch === ']') {
            d--;
            cursor++;
            continue;
        }
        if (d === 0 && ch !== undefined && /[A-Za-z_$]/.test(ch)) {
            let end = cursor;
            while (end < stripped.length) {
                const c = stripped[end];
                if (c === undefined || !/[A-Za-z0-9_$]/.test(c))
                    break;
                end++;
            }
            const name = stripped.slice(cursor, end);
            let look = end;
            while (look < stripped.length && /\s/.test(stripped[look] ?? ''))
                look++;
            if (stripped[look] === '(') {
                methods.push(name);
            }
            cursor = end;
            continue;
        }
        cursor++;
    }
    return methods;
}
describe('Storage method-shape gate', () => {
    it('exposes exactly the contract methods', () => {
        const src = readFileSync(SOURCE, 'utf-8');
        const methods = extractStorageMethods(src);
        expect(methods).toEqual([
            'read',
            'readBytes',
            'exists',
            'mtime',
            'list',
            'listEntries',
            'write',
            'append',
            'writeAtomic',
            'mkdir',
            'remove',
            'rename',
            'chmod',
        ]);
    });
});
