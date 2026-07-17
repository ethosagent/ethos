// End-to-end decay + restore through the REAL memory stack (§4.2 exit criteria):
// MarkdownFileMemoryProvider + the memory-history decorator + InMemoryStorage.
// Proves the every-byte-recoverable property across a decay pass and that a
// restore round-trips a section by slug — both history-recorded.

import { join } from 'node:path';
import { HistoryStore, withHistory } from '@ethosagent/memory-history';
import { MarkdownFileMemoryProvider } from '@ethosagent/memory-markdown';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { MemoryContext } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import type { ConsolidationResult, ScoredSection } from '../memory-consolidation';
import {
  emptyMeta,
  parseArchiveBlocks,
  planConsolidation,
  resolveDecayParams,
} from '../memory-decay';

const DATA = '/root/.ethos';
const SCOPE = 'personality:muse';
const SCOPE_DIR = join(DATA, 'personalities', 'muse');
const NOW = 1_800_000_000_000;

function ctx(over: Partial<MemoryContext> = {}): MemoryContext {
  return {
    scopeId: SCOPE,
    sessionId: 's1',
    sessionKey: 'cli',
    platform: 'cli',
    workingDir: '/tmp',
    ...over,
  };
}

function section(slug: string, content: string, score: number): ScoredSection {
  return { slug, content, score };
}

function scoredResult(memorySections: ScoredSection[]): ConsolidationResult {
  return {
    memory: memorySections.map((s) => `### ${s.slug}\n${s.content}`).join('\n\n'),
    user: '',
    memorySections,
    userSections: [],
    scored: true,
  };
}

describe('decay integration — every byte recoverable + reversible', () => {
  it('demotes a low-importance section and keeps all pre-run bytes recoverable', async () => {
    const storage = new InMemoryStorage();
    const base = new MarkdownFileMemoryProvider({ dir: DATA, storage });
    const history = new HistoryStore({ dataDir: DATA, storage });
    const consolidator = withHistory(base, history, { source: 'consolidation' });

    await storage.mkdir(SCOPE_DIR);
    // Seed a large MEMORY.md so the consolidation replace spills to a blob.
    const bigBody = Array.from({ length: 400 }, (_, i) => `keep-line-${i}-lorem-ipsum-dolor`).join(
      '\n',
    );
    const preRun = `### durable\n${bigBody}\n\n### trivia\nthrowaway detail to be archived`;
    await storage.write(join(SCOPE_DIR, 'MEMORY.md'), `${preRun}\n`);

    // Distilled result: durable stays high, trivia scored near-zero → archived.
    const res = scoredResult([
      section('durable', bigBody, 0.9),
      section('trivia', 'throwaway detail to be archived', 0.01),
    ]);
    const plan = planConsolidation({
      current: { memory: preRun, user: '' },
      result: res,
      meta: emptyMeta(),
      params: resolveDecayParams(undefined, NOW),
    });
    expect(plan.archivedSlugs).toEqual(['trivia']);

    await consolidator.sync(plan.updates, ctx());

    // MEMORY.md dropped the archived slug; the archive gained it.
    const postMemory = (await storage.read(join(SCOPE_DIR, 'MEMORY.md'))) ?? '';
    const archive = (await storage.read(join(SCOPE_DIR, 'memory-archive.md'))) ?? '';
    expect(postMemory).not.toContain('### trivia');
    expect(archive).toContain('### trivia');
    expect(archive).toContain('slug=trivia');

    // MEMORY.md carries ZERO metadata annotations — `### slug` headings are the
    // ONLY added structure (§4.1 exit criterion). Scores/lastSeen live in the
    // sidecar; archive markers live only in memory-archive.md.
    expect(postMemory).not.toContain('<!--');
    expect(postMemory).not.toContain('importance');
    expect(postMemory).not.toContain('slug=');

    // The consolidation MEMORY.md replace spilled its before-state to a blob.
    const hist = await history.read(SCOPE);
    expect(hist.entries.every((e) => e.source === 'consolidation')).toBe(true);

    // PROPERTY: every non-empty pre-run line survives somewhere recoverable —
    // post MEMORY.md, the archive, a history diff, or a content-addressed blob.
    const blobs: string[] = [];
    for (const e of hist.entries) {
      if (e.blob) blobs.push((await history.readBlob(SCOPE, e.blob)) ?? '');
    }
    const recoverable = [postMemory, archive, ...hist.entries.map((e) => e.diff), ...blobs].join(
      '\n',
    );
    for (const line of preRun.split('\n')) {
      const t = line.trim();
      if (t.length === 0) continue;
      expect(recoverable.includes(t)).toBe(true);
    }
  });

  it('restore round-trips an archived section by slug, history-recorded', async () => {
    const storage = new InMemoryStorage();
    const base = new MarkdownFileMemoryProvider({ dir: DATA, storage });
    const history = new HistoryStore({ dataDir: DATA, storage });
    const consolidator = withHistory(base, history, { source: 'consolidation' });
    const restorer = withHistory(base, history, { source: 'restore' });

    await storage.mkdir(SCOPE_DIR);
    const preRun = '### durable\nstays put\n\n### faded\nold context worth demoting';
    await storage.write(join(SCOPE_DIR, 'MEMORY.md'), `${preRun}\n`);

    const plan = planConsolidation({
      current: { memory: preRun, user: '' },
      result: scoredResult([
        section('durable', 'stays put', 0.9),
        section('faded', 'old context worth demoting', 0.0),
      ]),
      meta: emptyMeta(),
      params: resolveDecayParams(undefined, NOW),
    });
    await consolidator.sync(plan.updates, ctx());

    // Restore by slug: move the section back to MEMORY.md, empty the archive.
    const archive = (await base.read('memory-archive.md', ctx()))?.content ?? '';
    const blocks = parseArchiveBlocks(archive);
    const target = blocks.find((b) => b.slug === 'faded');
    expect(target).toBeDefined();
    if (!target) return;

    await restorer.sync(
      [
        { action: 'add', key: target.fromKey, content: target.section },
        { action: 'replace', key: 'memory-archive.md', content: '' },
      ],
      ctx(),
    );

    const postMemory = (await storage.read(join(SCOPE_DIR, 'MEMORY.md'))) ?? '';
    expect(postMemory).toContain('### faded');
    expect(postMemory).toContain('old context worth demoting');

    const hist = await history.read(SCOPE);
    expect(hist.entries.some((e) => e.source === 'restore')).toBe(true);
  });
});
