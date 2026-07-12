import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// P2.4 — FsStorage construction is confined to WIRING / composition-root code.
//
// This is the load-bearing SaaS isolation boundary, not hygiene. Library code
// (extensions/*, the web-api data layer) must RECEIVE an injected `Storage`;
// it must never construct `new FsStorage()` as a silent fallback. A module
// that reaches for raw disk instead of the storage it was handed defeats the
// per-personality (and, later, per-tenant) scoping boundary.
//
// Composition roots — packages/wiring, apps/ethos/src/wiring.ts +
// commands/*, apps/desktop main, apps/tui, apps/web-api/src/index.ts — are the
// sanctioned places to construct FsStorage and thread it down. They are OUT of
// this scan's scope by construction (the scan only covers the library layers
// below).
//
// Mirrors the source-scan style of apps/web-api/src/__tests__/layering.test.ts.

// __tests__ -> src -> types -> packages -> <repo root>
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');

// Directories that make up the scanned library layers.
const SCANNED_DIRS = [
  join(REPO_ROOT, 'extensions'),
  join(REPO_ROOT, 'apps', 'web-api', 'src', 'repositories'),
  join(REPO_ROOT, 'apps', 'web-api', 'src', 'services'),
];

// Explicit, reasoned exceptions. The GOAL is an EMPTY allowlist for the
// converted library layers — every entry here is debt with a reason, not a
// license to add more. As of P2.4 completion the allowlist is EMPTY: every
// library layer (extensions/*, the web-api repositories/services layer)
// receives an injected Storage and constructs none.
const ALLOWLIST = new Set<string>([]);

const FS_STORAGE_CONSTRUCTION = /new\s+FsStorage\s*\(/;

function listTs(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // directory may not exist in every checkout slice
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules' || entry === 'dist') continue;
      out.push(...listTs(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('P2.4 — FsStorage construction confined to wiring', () => {
  it('no library-layer module constructs `new FsStorage()` outside the allowlist', () => {
    const offenders: string[] = [];
    for (const dir of SCANNED_DIRS) {
      for (const file of listTs(dir)) {
        const rel = relative(REPO_ROOT, file);
        if (ALLOWLIST.has(rel)) continue;
        if (FS_STORAGE_CONSTRUCTION.test(readFileSync(file, 'utf-8'))) {
          offenders.push(rel);
        }
      }
    }
    expect(
      offenders,
      `Library code must receive an injected Storage, not construct FsStorage. Thread the\n` +
        `Storage from the composition root (wiring / app entry) instead. Offenders:\n${offenders.join(
          '\n',
        )}`,
    ).toEqual([]);
  });

  it('the web-api repositories/services layer carries NO allowlist exceptions', () => {
    // The hosted request path is the actual isolation boundary — keep it clean.
    const webApiExceptions = [...ALLOWLIST].filter(
      (p) =>
        p.startsWith('apps/web-api/src/repositories') || p.startsWith('apps/web-api/src/services'),
    );
    expect(webApiExceptions).toEqual([]);
  });
});
