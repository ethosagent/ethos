import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// W5 (ux-feedback plan) — colours are tokens, not literals. This pins
// `styles.css` so a NEW raw hex cannot land silently, while tolerating what
// legitimately exists today:
//   • the leading `:root` token-definition block (the pre-hydration fallback
//     DESIGN.md's runtime <style> overrides),
//   • hex used as a `var(--x, #hex)` fallback (the token IS the source),
//   • pure white/black (`#fff`/`#ffffff`/`#000`) on accent-filled glyphs,
//   • the frozen allowlist below — pre-existing literals, each a candidate
//     for its own token cleanup. Removing one is progress (the assertion is
//     "subset of"); adding one fails.
// The `.composer-stop-btn` reds (#ef4444/#dc2626) were removed by W5 and must
// never come back — they are asserted absent outright.

const cssPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'styles.css');
const css = readFileSync(cssPath, 'utf8');

/** Everything after the first `:root { … }` block — the token region itself
 *  is allowed to define hex values; that is what it is for. */
function afterTokenBlock(source: string): string {
  const start = source.indexOf(':root {');
  if (start < 0) return source;
  const end = source.indexOf('\n}', start);
  return end < 0 ? source : source.slice(end + 2);
}

/** Raw hex literals outside token definitions and var() fallbacks. */
function offendingHexes(source: string): string[] {
  const body = afterTokenBlock(source)
    // A `var(--token, #hex)` fallback names the token first; the literal is
    // the no-skin bootstrap value, not a colour decision.
    .replace(/var\([^)]*\)/g, '')
    // Comments may cite hexes when recording decisions.
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const hexes = body.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  return [...new Set(hexes.map((h) => h.toLowerCase()))].filter(
    (h) => !['#fff', '#ffffff', '#000', '#000000'].includes(h),
  );
}

// Pre-existing literals, frozen 2026-09-26 (ux-feedback W5). Shrink, never grow.
const LEGACY_HEX_ALLOWLIST = new Set([
  '#6ab0ff', // send-btn hover fallback lineage
  '#4a9eff', // DESIGN.md's own sidebar active-state spec value
  '#67e8f9', // syntax highlight cyan
  '#fbbf24', // syntax highlight amber
  '#e879f9', // coach accent literal in a gradient-free chart rule
  '#1890ff', // antd-blue dashed drop target
]);

describe('styles.css — tokens only (W5)', () => {
  it('the composer stop button reds are gone for good', () => {
    expect(css).not.toContain('#ef4444');
    expect(css).not.toContain('#dc2626');
  });

  it('no NEW raw hex outside the token block, var() fallbacks and white/black', () => {
    const offending = offendingHexes(css);
    const unexpected = offending.filter((h) => !LEGACY_HEX_ALLOWLIST.has(h));
    expect(unexpected).toEqual([]);
  });
});

// The other stylesheets the web app ships are token-only TODAY — no legacy
// allowlist, so the assertion is simply "and they stay that way". A new
// stylesheet belongs in this table.
const TOKEN_ONLY_STYLESHEETS = [
  'pages/settings/settings-ux.css',
  'components/ui/state-blocks.css',
] as const;

describe.each(TOKEN_ONLY_STYLESHEETS)('%s — tokens only, no allowlist', (relPath) => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', relPath), 'utf8');

  it('has no raw hex outside token definitions and var() fallbacks', () => {
    expect(offendingHexes(source)).toEqual([]);
  });
});
