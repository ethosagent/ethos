// Fact lifecycle L4 (§3c) — supersede + retract through the REAL memory stack
// (MarkdownFileMemoryProvider + memory-history decorator + InMemoryStorage).
//
// Proves the L4 §4 "MEMORY.md contains only active sections" grep-level check:
// after supersede/retract the live file holds only active `### <slug>` sections,
// the moved section lands in the archive with its note, and the sidecar records
// the lifecycle state. The retract tombstone contract is proven end-to-end
// against real capture dedup in memory-capture's lifecycle-retract.test.ts.

import { join } from 'node:path';
import { HistoryStore, withHistory } from '@ethosagent/memory-history';
import { MarkdownFileMemoryProvider } from '@ethosagent/memory-markdown';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { MemoryContext } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { emptyMeta, type MemoryMeta, parseMemoryMeta } from '../memory-decay';
import { retractSlug, supersedeSlug } from '../memory-lifecycle';

const DATA = '/root/.ethos';
const SCOPE = 'personality:muse';
const SCOPE_DIR = join(DATA, 'personalities', 'muse');
const META_PATH = join(SCOPE_DIR, 'memory-meta.json');
const NOW = 1_800_000_000_000;

function ctx(): MemoryContext {
  return {
    scopeId: SCOPE,
    sessionId: 's1',
    sessionKey: 'cli',
    platform: 'cli',
    workingDir: '/tmp',
  };
}

function harness() {
  const storage = new InMemoryStorage();
  const base = new MarkdownFileMemoryProvider({ dir: DATA, storage });
  const history = new HistoryStore({ dataDir: DATA, storage });
  const provider = withHistory(base, history, { source: 'tool' });

  const readMeta = async (): Promise<MemoryMeta> => parseMemoryMeta(await storage.read(META_PATH));
  const writeMeta = async (meta: MemoryMeta): Promise<void> => {
    await storage.mkdir(SCOPE_DIR);
    await storage.writeAtomic(META_PATH, JSON.stringify(meta, null, 2));
  };

  const tombstoned: Array<{ hash: string; reason?: string }> = [];
  return {
    storage,
    provider,
    history,
    readMeta,
    writeMeta,
    tombstoned,
    hashFact: (t: string) => `h(${t.trim().toLowerCase()})`,
    addTombstone: async (hash: string, reason?: string) => {
      tombstoned.push({ hash, reason });
    },
  };
}

async function seedMemory(
  storage: InMemoryStorage,
  provider: { sync: MarkdownFileMemoryProvider['sync'] },
  body: string,
): Promise<void> {
  await storage.mkdir(SCOPE_DIR);
  await provider.sync([{ action: 'replace', key: 'MEMORY.md', content: body }], ctx());
}

const TWO_SECTIONS = '### laptop-model\nThinkPad X1 (2021).\n\n### coffee-order\nOat flat white.';

describe('memory lifecycle — supersede', () => {
  it('moves the superseded section to the archive; MEMORY.md keeps only active sections', async () => {
    const h = harness();
    await seedMemory(h.storage, h.provider, TWO_SECTIONS);

    const res = await supersedeSlug(h.provider, ctx(), 'laptop-model', 'laptop-model-2024', {
      readMeta: h.readMeta,
      writeMeta: h.writeMeta,
      now: NOW,
    });
    expect(res.ok).toBe(true);

    const memory = (await h.provider.read('MEMORY.md', ctx()))?.content ?? '';
    // Grep-level assertion: the live file holds only the active section.
    expect(memory).toContain('### coffee-order');
    expect(memory).not.toContain('### laptop-model');
    expect(memory).not.toContain('ThinkPad');

    const archive = (await h.provider.read('memory-archive.md', ctx()))?.content ?? '';
    expect(archive).toContain('### laptop-model');
    expect(archive).toContain('ThinkPad');
    expect(archive).toContain('Superseded by [[#laptop-model-2024]]');

    const meta = await h.readMeta();
    const entry = meta.keys['MEMORY.md']?.['laptop-model'];
    expect(entry?.state).toBe('superseded');
    expect(entry?.supersededBy).toBe('laptop-model-2024');
  });

  it('errors with the active slug list when the slug is absent', async () => {
    const h = harness();
    await seedMemory(h.storage, h.provider, TWO_SECTIONS);
    const res = await supersedeSlug(h.provider, ctx(), 'nope', 'x', {
      readMeta: h.readMeta,
      writeMeta: h.writeMeta,
      now: NOW,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.availableSlugs).toEqual(['laptop-model', 'coffee-order']);
  });
});

describe('memory lifecycle — retract', () => {
  it('archives the section, tombstones every fact, and records retractedHashes', async () => {
    const h = harness();
    await seedMemory(h.storage, h.provider, '### bad-fact\nUser hates cilantro.');

    const res = await retractSlug(
      h.provider,
      ctx(),
      'bad-fact',
      {
        readMeta: h.readMeta,
        writeMeta: h.writeMeta,
        hashFact: h.hashFact,
        addTombstone: h.addTombstone,
        now: NOW,
      },
      'was a wrong inference',
    );
    expect(res.ok).toBe(true);

    const memory = (await h.provider.read('MEMORY.md', ctx()))?.content ?? '';
    expect(memory).not.toContain('cilantro');

    const archive = (await h.provider.read('memory-archive.md', ctx()))?.content ?? '';
    expect(archive).toContain('### bad-fact');
    expect(archive).toContain('Retracted: was a wrong inference');

    // The whole-body fact was tombstoned with the retract reason.
    expect(h.tombstoned.map((t) => t.hash)).toContain('h(user hates cilantro.)');
    expect(h.tombstoned[0]?.reason).toBe('was a wrong inference');

    const meta = await h.readMeta();
    expect(meta.keys['MEMORY.md']?.['bad-fact']?.state).toBe('retracted');
    expect(meta.retractedHashes).toContain('h(user hates cilantro.)');
  });

  it('read-modify-write preserves other slugs decay bookkeeping (single-writer guard)', async () => {
    const h = harness();
    await seedMemory(h.storage, h.provider, TWO_SECTIONS);
    // A prior nightly pass recorded importance for an unrelated slug.
    const seeded = emptyMeta();
    seeded.keys['MEMORY.md'] = { 'coffee-order': { importance: 0.9, lastSeen: NOW - 1000 } };
    await h.writeMeta(seeded);

    await retractSlug(h.provider, ctx(), 'laptop-model', {
      readMeta: h.readMeta,
      writeMeta: h.writeMeta,
      hashFact: h.hashFact,
      addTombstone: h.addTombstone,
      now: NOW,
    });

    const meta = await h.readMeta();
    // The unrelated slug's importance survived untouched.
    expect(meta.keys['MEMORY.md']?.['coffee-order']?.importance).toBe(0.9);
    expect(meta.keys['MEMORY.md']?.['laptop-model']?.state).toBe('retracted');
  });
});
