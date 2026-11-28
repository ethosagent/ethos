import { describe, expect, it } from 'vitest';
import {
  INITIATIVE_CHAT_TOOLS,
  INITIATIVE_LEDGER_TOOLS,
  INITIATIVE_NEVER_TOOLS,
  INITIATIVE_READ_TOOLS,
  runToolNames,
} from '../index';

describe('initiative tool classes (L1)', () => {
  it('allowlist is frozen', () => {
    expect(Object.isFrozen(INITIATIVE_READ_TOOLS)).toBe(true);
    expect(Object.isFrozen(INITIATIVE_LEDGER_TOOLS)).toBe(true);
    expect(Object.isFrozen(INITIATIVE_CHAT_TOOLS)).toBe(true);
    expect(Object.isFrozen(INITIATIVE_NEVER_TOOLS)).toBe(true);
    expect(() => (INITIATIVE_READ_TOOLS as unknown as string[]).push('x')).toThrow();
    const never = INITIATIVE_NEVER_TOOLS as Set<string>;
    expect(() => never.add('x')).toThrow();
    expect(() => never.delete('send_message')).toThrow();
    expect(INITIATIVE_NEVER_TOOLS.has('x')).toBe(false);
    expect(INITIATIVE_NEVER_TOOLS.has('send_message')).toBe(true);
  });

  it('no name is in both READ and NEVER', () => {
    for (const name of INITIATIVE_READ_TOOLS) expect(INITIATIVE_NEVER_TOOLS.has(name)).toBe(false);
  });

  it('the four classes are pairwise disjoint', () => {
    const lists = {
      read: [...INITIATIVE_READ_TOOLS],
      ledger: [...INITIATIVE_LEDGER_TOOLS],
      chat: [...INITIATIVE_CHAT_TOOLS],
      never: [...INITIATIVE_NEVER_TOOLS],
    };
    const owner = new Map<string, string>();
    for (const [cls, names] of Object.entries(lists)) {
      expect(new Set(names).size).toBe(names.length);
      for (const n of names) {
        expect(owner.get(n), `${n} in ${owner.get(n)} and ${cls}`).toBeUndefined();
        owner.set(n, cls);
      }
    }
  });

  it('runToolNames intersects with the toolset', () => {
    const names = runToolNames(['web_search', 'web_extract', 'send_message']);
    expect(names).toContain('web_search');
    expect(names).toContain('web_extract');
    expect(names).not.toContain('linkedin_search');
    expect(names).not.toContain('send_message');
  });

  it('runToolNames always adds the ledger tools', () => {
    const names = runToolNames(['web_search']);
    for (const t of INITIATIVE_LEDGER_TOOLS) expect(names).toContain(t);
  });

  it('an empty toolset yields only ledger tools; "*" is not a wildcard', () => {
    expect(runToolNames([])).toEqual([...INITIATIVE_LEDGER_TOOLS]);
    expect(runToolNames(['*'])).toEqual([...INITIATIVE_LEDGER_TOOLS]);
  });

  it('an unrestricted (undefined) toolset yields the full read allowlist', () => {
    expect(runToolNames(undefined)).toEqual([...INITIATIVE_READ_TOOLS, ...INITIATIVE_LEDGER_TOOLS]);
  });

  it('a toolset cannot add tools outside the allowlist', () => {
    const names = runToolNames(['terminal', 'write_file', 'initiative_define', 'web_search']);
    expect(names).not.toContain('terminal');
    expect(names).not.toContain('write_file');
    expect(names).not.toContain('initiative_define');
  });

  it('initiative_define is never a run tool', () => {
    expect(runToolNames(['initiative_define', 'initiative_add_ideas'])).not.toContain(
      'initiative_define',
    );
    expect(runToolNames(undefined)).not.toContain('initiative_define');
    expect(runToolNames(undefined)).not.toContain('initiative_add_ideas');
    expect(INITIATIVE_CHAT_TOOLS).toContain('initiative_define');
  });

  it('runToolNames result order is stable and has no duplicates', () => {
    const names = runToolNames(['read_file', 'web_search', 'clarify']);
    expect(new Set(names).size).toBe(names.length);
    expect(names.indexOf('web_search')).toBeLessThan(names.indexOf('read_file'));
  });
});

describe('initiative tool classes: world model', () => {
  const READS = ['world_query', 'world_neighbours', 'world_history'];
  const WRITES = [
    'world_assert',
    'world_propose',
    'world_close',
    'world_schema_change',
    'world_import',
    'world_build',
    'world_export',
  ];

  it('the three world reads are READ tools, free per call', () => {
    for (const n of READS) {
      expect(INITIATIVE_READ_TOOLS as readonly string[]).toContain(n);
      expect(runToolNames(undefined)).toContain(n);
    }
  });

  it('every world write (and the export artifact) is NEVER and never a run tool', () => {
    for (const n of WRITES) {
      expect(INITIATIVE_NEVER_TOOLS.has(n), n).toBe(true);
      expect(runToolNames([n])).not.toContain(n);
    }
  });
});
