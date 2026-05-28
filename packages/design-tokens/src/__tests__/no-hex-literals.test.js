import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// Phase 1 acceptance — guardrail replacing the plan's three lint rules.
// Biome 2 doesn't expose a generic noRestrictedSyntax rule, so this test
// scans the gated files for the patterns the plan forbids:
//
//   1. No hex literal in apps/tui/src/skin.ts, apps/web/src/lib/theme.ts,
//      or anywhere under apps/ethos/src/. (Tokens come from
//      @ethosagent/design-tokens — fail-fast if a literal creeps back.)
//   2. No numeric `borderRadius` literal in apps/web/src/lib/theme.ts or
//      apps/web/src/components/**. (Must come from tokens.radius.*.)
//   3. No hardcoded layout magic numbers (240, 64, 360, 800, 520) on
//      width/maxWidth in apps/web/src/components/**. (Must use
//      var(--layout-*) injected at the root.)
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
function abs(rel) {
    return join(REPO_ROOT, rel);
}
function walkFiles(dir, predicate) {
    const out = [];
    const queue = [dir];
    while (queue.length > 0) {
        const current = queue.shift();
        let entries;
        try {
            entries = readdirSync(current);
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            const full = join(current, entry);
            let stat;
            try {
                stat = statSync(full);
            }
            catch {
                continue;
            }
            if (stat.isDirectory()) {
                // Skip node_modules / dist / hidden dirs.
                if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.'))
                    continue;
                queue.push(full);
                continue;
            }
            if (predicate(full))
                out.push(full);
        }
    }
    return out;
}
const HEX_PATTERN = /#[0-9a-fA-F]{3,8}\b/g;
const BORDER_RADIUS_NUM = /\bborderRadius\s*:\s*\d+\b/g;
// Catch `width: 240`, `maxWidth: 240`, `width: '240px'`, `width="240"`.
const LAYOUT_NUMBERS = ['240', '64', '360', '800', '520'];
const LAYOUT_PATTERN = new RegExp(String.raw `\b(width|maxWidth|max-width)\s*[:=]\s*['"]?(` +
    LAYOUT_NUMBERS.join('|') +
    `)(px)?['"]?`, 'g');
function stripBlockComments(src) {
    // Drop /* ... */ blocks; line comments left in (we only have a few hex/literal
    // hits in comments and the grep can mark them as exempt with `/* token */`
    // markers if needed in the future).
    return src.replace(/\/\*[\s\S]*?\*\//g, '');
}
describe('Phase 1 guardrail: no hex literals in gated files', () => {
    const gatedFiles = [abs('apps/tui/src/skin.ts'), abs('apps/web/src/lib/theme.ts')];
    for (const file of gatedFiles) {
        it(`${file.slice(REPO_ROOT.length + 1)} has no hex literals`, () => {
            const src = stripBlockComments(readFileSync(file, 'utf8'));
            const matches = src.match(HEX_PATTERN);
            expect(matches, `Hex literals found in ${file}: ${matches?.join(', ')}. Read from @ethosagent/design-tokens instead.`).toBeNull();
        });
    }
    it('apps/ethos/src/** has no hex literals', () => {
        const files = walkFiles(abs('apps/ethos/src'), (p) => p.endsWith('.ts') || p.endsWith('.tsx'));
        const offenders = [];
        for (const file of files) {
            const src = stripBlockComments(readFileSync(file, 'utf8'));
            const matches = src.match(HEX_PATTERN);
            if (matches)
                offenders.push({ file: file.slice(REPO_ROOT.length + 1), hits: matches });
        }
        expect(offenders, `Hex literals found in apps/ethos/src/: ${JSON.stringify(offenders)}`).toEqual([]);
    });
});
describe('Phase 1 guardrail: no numeric borderRadius in gated files', () => {
    it('apps/web/src/lib/theme.ts has no numeric borderRadius literal', () => {
        const src = stripBlockComments(readFileSync(abs('apps/web/src/lib/theme.ts'), 'utf8'));
        const matches = src.match(BORDER_RADIUS_NUM);
        expect(matches, `Numeric borderRadius in theme.ts: ${matches?.join(', ')}`).toBeNull();
    });
    it('apps/web/src/components/** has no numeric borderRadius literal', () => {
        const files = walkFiles(abs('apps/web/src/components'), (p) => p.endsWith('.tsx'));
        const offenders = [];
        for (const file of files) {
            const src = stripBlockComments(readFileSync(file, 'utf8'));
            const matches = src.match(BORDER_RADIUS_NUM);
            if (matches)
                offenders.push({ file: file.slice(REPO_ROOT.length + 1), hits: matches });
        }
        // `borderRadius: 0` is the only allowed numeric — it's "disable rounding",
        // not a scale value. Filter those out.
        const real = offenders
            .map((o) => ({ ...o, hits: o.hits.filter((h) => !/borderRadius\s*:\s*0\b/.test(h)) }))
            .filter((o) => o.hits.length > 0);
        expect(real, `Numeric borderRadius in components/: ${JSON.stringify(real)}`).toEqual([]);
    });
});
describe('Phase 1 guardrail: no layout magic numbers in components/', () => {
    it('width / maxWidth in apps/web/src/components/** does not hardcode 240/64/360/800/520', () => {
        const files = walkFiles(abs('apps/web/src/components'), (p) => p.endsWith('.tsx'));
        const offenders = [];
        for (const file of files) {
            const src = stripBlockComments(readFileSync(file, 'utf8'));
            const matches = src.match(LAYOUT_PATTERN);
            if (matches)
                offenders.push({ file: file.slice(REPO_ROOT.length + 1), hits: matches });
        }
        expect(offenders, `Layout magic numbers in components/: ${JSON.stringify(offenders)}. Use var(--layout-*).`).toEqual([]);
    });
});
