import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CATALOG_KINDS } from '@ethosagent/types';
import { CatalogEntrySchema } from '@ethosagent/web-contracts';
import { describe, expect, it } from 'vitest';
import { CATALOG_ENTRIES, catalogEntriesOfKind, getCatalogEntry } from '../index';

// Offline checks only (plan/phases/unified-catalog.md D20): facts that cannot
// rot. Reachability, digests and OSV belong to the admission script.
const ENTRIES_DIR = join(import.meta.dirname, '..', 'entries');

// Same predicates as extensions/tools-mcp/src/__tests__/presets-pinned.test.ts.
const NPM_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const PYPI_VERSION = /^\d+(\.\d+)+([.-]?[0-9A-Za-z]+)*$/;

describe('catalog index', () => {
  it('holds the 16 seed entries', () => {
    expect(CATALOG_ENTRIES).toHaveLength(16);
    expect(catalogEntriesOfKind('mcp')).toHaveLength(16);
    expect(catalogEntriesOfKind('plugin')).toHaveLength(0);
    expect(catalogEntriesOfKind('skill')).toHaveLength(0);
  });

  it('every entry parses with CatalogEntrySchema', () => {
    for (const e of CATALOG_ENTRIES) {
      const parsed = CatalogEntrySchema.safeParse(e);
      expect(parsed.success, `${e.id}: ${parsed.success ? '' : parsed.error.message}`).toBe(true);
    }
  });

  it('ids are unique across kinds', () => {
    const ids = CATALOG_ENTRIES.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('getCatalogEntry finds by id and returns undefined otherwise', () => {
    expect(getCatalogEntry('linear')?.name).toBe('Linear');
    expect(getCatalogEntry('nope')).toBeUndefined();
  });

  it('the barrel lists every file under entries/ and nothing else', () => {
    const onDisk: string[] = [];
    for (const kind of CATALOG_KINDS) {
      let files: string[] = [];
      try {
        files = readdirSync(join(ENTRIES_DIR, kind));
      } catch {
        continue; // no directory yet for this kind
      }
      for (const f of files) {
        expect(f.endsWith('.ts'), `${kind}/${f}`).toBe(true);
        onDisk.push(`${kind}/${f.slice(0, -3)}`);
      }
    }
    const inBarrel = CATALOG_ENTRIES.map((e) => `${e.kind}/${e.id}`);
    expect(inBarrel.sort()).toEqual(onDisk.sort());
  });

  it('every npm/pypi pin is an exact version', () => {
    for (const e of CATALOG_ENTRIES) {
      if (e.pin.type === 'npm') expect(e.pin.version, e.id).toMatch(NPM_VERSION);
      if (e.pin.type === 'pypi') expect(e.pin.version, e.id).toMatch(PYPI_VERSION);
      if (e.pin.type === 'npm')
        expect(e.pin.integrity, e.id).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
      if (e.pin.type === 'pypi') expect(e.pin.integrity, e.id).toMatch(/^sha256-[0-9a-f]{64}$/);
    }
  });

  it('kind mcp entries have an mcp block iff the pin is npm or pypi', () => {
    for (const e of catalogEntriesOfKind('mcp')) {
      const local = e.pin.type === 'npm' || e.pin.type === 'pypi';
      expect(e.mcp !== undefined, e.id).toBe(local);
    }
  });

  it("no entry is tier official unless its publisher is 'Ethos'", () => {
    for (const e of CATALOG_ENTRIES) {
      if (e.tier === 'official') expect(e.publisher, e.id).toBe('Ethos');
    }
  });

  it('no plugin entry is tier community (D19)', () => {
    for (const e of catalogEntriesOfKind('plugin')) expect(e.tier, e.id).not.toBe('community');
  });

  it('every entry that ships code has a non-null licence; remotes have none', () => {
    for (const e of CATALOG_ENTRIES) {
      if (e.pin.type === 'remote') expect(e.license, e.id).toBeNull();
      else expect(e.license, e.id).toEqual(expect.any(String));
    }
  });

  it('the seed tiers follow D5', () => {
    const community = CATALOG_ENTRIES.filter((e) => e.tier === 'community').map((e) => e.id);
    expect(community).toEqual(['google-calendar']);
    expect(CATALOG_ENTRIES.filter((e) => e.tier === 'official')).toEqual([]);
  });

  it('toolCount, when set, is a non-negative integer', () => {
    for (const e of CATALOG_ENTRIES) {
      const n = e.capabilities.toolCount;
      if (n !== undefined) expect(Number.isInteger(n) && n >= 0, e.id).toBe(true);
    }
  });
});
