// `RunOptions.readmitReadTools` — an opt-in, incognito-owner-only re-admission
// of READ tools (`INCOGNITO_READ_READMITTABLE_TOOLS`, agent-loop/audience.ts).
// Enforcers: `withSharedAudienceExclusions(…, readmit, readmitReads)` and its
// one call in `setupTurn` (stages/turn-setup.ts), which passes `incognito &&
// opts.readmitReadTools === true`; `incognito` is never true for a shared
// caller or an inherited-incognito child.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  INCOGNITO_READ_READMITTABLE_TOOLS,
  SHARED_AUDIENCE_EXCLUDED_TOOLS,
  withSharedAudienceExclusions,
} from '../agent-loop/audience';
import { build, drain } from './incognito-harness';

const READS = ['memory_read', 'session_list_by_date'];

describe('INCOGNITO_READ_READMITTABLE_TOOLS', () => {
  it('is exactly the two read tools, all inside the shared exclusion list, no write tool', () => {
    expect([...INCOGNITO_READ_READMITTABLE_TOOLS].sort()).toEqual([...READS].sort());
    for (const name of INCOGNITO_READ_READMITTABLE_TOOLS) {
      expect(SHARED_AUDIENCE_EXCLUDED_TOOLS).toContain(name);
      expect(name).not.toMatch(/write|_add|_update|_delete|_set/);
    }
  });
});

describe('withSharedAudienceExclusions(…, readmit, readmitReads)', () => {
  it('skips the read tools only with both flags; never memory_write or team memory writes', () => {
    const both = withSharedAudienceExclusions('shared', undefined, true, true) ?? [];
    for (const name of READS) expect(both).not.toContain(name);
    for (const name of ['memory_write', 'team_memory_write', 'team_memory_read']) {
      expect(both).toContain(name);
    }
    for (const flags of [
      [false, false],
      [true, false],
      [false, true],
    ] as const) {
      const out = withSharedAudienceExclusions('shared', undefined, flags[0], flags[1]) ?? [];
      for (const name of READS) expect(out).toContain(name);
    }
  });

  it('a caller exclusion naming a read tool keeps it excluded', () => {
    const out = withSharedAudienceExclusions('shared', ['memory_read'], true, true) ?? [];
    expect(out).toContain('memory_read');
    expect(out).not.toContain('session_list_by_date');
  });
});

describe('RunOptions.readmitReadTools in a real turn', () => {
  it('incognito + flag: the read tools are defined and execute; writes stay out', async () => {
    const { loop, calls, runs } = build({ attempt: 'memory_read' });
    await drain(loop.run('hi', { sessionKey: 'cli:rr1', incognito: true, readmitReadTools: true }));
    const names = calls[0]?.tools ?? [];
    for (const name of READS) expect(names).toContain(name);
    expect(names).not.toContain('memory_write');
    expect(runs).toContain('memory_read');
  });

  it('incognito without the flag: read tools stay out', async () => {
    const { loop, calls } = build();
    await drain(loop.run('hi', { sessionKey: 'cli:rr2', incognito: true }));
    for (const name of READS) expect(calls[0]?.tools).not.toContain(name);
  });

  it('a caller toolsetExclude naming memory_read wins over the flag', async () => {
    const { loop, calls } = build();
    await drain(
      loop.run('hi', {
        sessionKey: 'cli:rr3',
        incognito: true,
        readmitReadTools: true,
        toolsetExclude: ['memory_read'],
      }),
    );
    expect(calls[0]?.tools).not.toContain('memory_read');
    expect(calls[0]?.tools).toContain('session_list_by_date');
  });

  it.each([
    ['roomAudience: shared', { roomAudience: 'shared' as const }],
    ['skipPersonalityMemory', { skipPersonalityMemory: true }],
  ])('a caller-shared turn never gets them (%s)', async (label, extra) => {
    const { loop, calls } = build();
    await drain(
      loop.run('hi', {
        sessionKey: `cli:rr-shared-${label}`,
        incognito: true,
        readmitReadTools: true,
        ...extra,
      }),
    );
    for (const name of READS) expect(calls[0]?.tools).not.toContain(name);
  });

  it('a non-incognito shared turn never gets them', async () => {
    const { loop, calls } = build();
    await drain(
      loop.run('hi', { sessionKey: 'cli:rr4', roomAudience: 'shared', readmitReadTools: true }),
    );
    for (const name of READS) expect(calls[0]?.tools).not.toContain(name);
  });

  it('an inherited-incognito child never gets them', async () => {
    const { loop, calls } = build();
    await drain(loop.run('one', { sessionKey: 'cli:rr5', incognito: true }));
    await drain(loop.run('child', { sessionKey: 'cli:rr5:sub:abc', readmitReadTools: true }));
    for (const name of READS) expect(calls[1]?.tools).not.toContain(name);
  });

  it('memory_write is never runnable, even attempted with the flag', async () => {
    const { loop, runs } = build({ attempt: 'memory_write' });
    await drain(loop.run('hi', { sessionKey: 'cli:rr6', incognito: true, readmitReadTools: true }));
    expect(runs).not.toContain('memory_write');
  });
});

describe('who sets readmitReadTools', () => {
  it('only core (declaration) and the initiative runner assign it in source', () => {
    const root = join(__dirname, '..', '..', '..', '..');
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        if (['node_modules', 'dist', '.git', '__tests__', 'plan', '.logs'].includes(entry))
          continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry) && /readmitReadTools/.test(readFileSync(full, 'utf8'))) {
          hits.push(relative(root, full).split(sep).join('/'));
        }
      }
    };
    for (const top of ['packages', 'extensions', 'apps']) walk(join(root, top));
    const allowed = (f: string) =>
      f.startsWith('packages/core/src/') || f === 'extensions/initiative-runner/src/run-loop.ts';
    expect(hits.filter((f) => !allowed(f))).toEqual([]);
  });
});
