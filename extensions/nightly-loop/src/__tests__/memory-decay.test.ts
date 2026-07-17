import type { MemoryUpdate } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import type { ConsolidationResult, ScoredSection } from '../memory-consolidation';
import {
  type DecayParams,
  emptyMeta,
  formatArchiveBlock,
  type MemoryMeta,
  parseArchiveBlocks,
  parseMemoryMeta,
  planConsolidation,
  resolveDecayParams,
} from '../memory-decay';

/** Narrow a MemoryUpdate to its content (add/replace only). */
function contentOf(u: MemoryUpdate | undefined): string {
  return u && 'content' in u ? u.content : '';
}

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function params(over: Partial<DecayParams> = {}): DecayParams {
  return { halfLifeMs: 30 * DAY, threshold: 0.05, exemptUser: true, now: NOW, ...over };
}

function memSection(slug: string, score: number, content = `body-${slug}`): ScoredSection {
  return { slug, content, score };
}

function result(
  memorySections: ScoredSection[],
  userSections: ScoredSection[] = [],
): ConsolidationResult {
  const memory = memorySections.map((s) => `### ${s.slug}\n${s.content}`).join('\n\n');
  const user = userSections.map((s) => `### ${s.slug}\n${s.content}`).join('\n\n');
  return { memory, user, memorySections, userSections, scored: true };
}

describe('resolveDecayParams', () => {
  it('applies §4.3 defaults (30d half-life, 0.05 threshold, USER exempt)', () => {
    const p = resolveDecayParams(undefined, NOW);
    expect(p.halfLifeMs).toBe(30 * DAY);
    expect(p.threshold).toBe(0.05);
    expect(p.exemptUser).toBe(true);
  });

  it('honours overrides, including an explicit exemptUser: false', () => {
    const p = resolveDecayParams({ halfLifeDays: 10, threshold: 0.2, exemptUser: false }, NOW);
    expect(p.halfLifeMs).toBe(10 * DAY);
    expect(p.threshold).toBe(0.2);
    expect(p.exemptUser).toBe(false);
  });
});

describe('planConsolidation — decay demotes stale/low, keeps high', () => {
  it('archives a low-importance section and keeps a high-importance one', () => {
    const res = result([memSection('durable', 0.9), memSection('trivia', 0.01)]);
    const plan = planConsolidation({
      current: { memory: 'old', user: '' },
      result: res,
      meta: emptyMeta(),
      params: params(),
    });

    expect(plan.archivedSlugs).toEqual(['trivia']);
    const replace = plan.updates.find((u) => u.key === 'MEMORY.md');
    expect(replace?.action).toBe('replace');
    expect(contentOf(replace)).toContain('### durable');
    expect(contentOf(replace)).not.toContain('### trivia');

    const archiveAdd = plan.updates.find((u) => u.key === 'memory-archive.md');
    expect(archiveAdd?.action).toBe('add');
    expect(contentOf(archiveAdd)).toContain('slug=trivia');
    expect(contentOf(archiveAdd)).toContain('### trivia');

    // Only the kept slug survives in the sidecar.
    expect(Object.keys(plan.nextMeta.keys['MEMORY.md'] ?? {})).toEqual(['durable']);
  });

  it('archives a stale (old lastSeen) mid-importance section', () => {
    const meta: MemoryMeta = {
      version: 1,
      keys: { 'MEMORY.md': { stale: { importance: 0.5, lastSeen: NOW - 120 * DAY } } },
    };
    const res = result([memSection('stale', 0.5), memSection('fresh', 0.5)]);
    const plan = planConsolidation({
      current: { memory: 'old', user: '' },
      result: res,
      meta,
      params: params(),
    });
    // 0.5 * 2^(-120/30) = 0.03125 < 0.05 → archived; fresh (now) = 0.5 → kept.
    expect(plan.archivedSlugs).toEqual(['stale']);
  });

  it('preserves lastSeen across a reword (same slug, new content, meta intact)', () => {
    const seededAt = NOW - 5 * DAY;
    const meta: MemoryMeta = {
      version: 1,
      keys: { 'MEMORY.md': { topic: { importance: 0.8, lastSeen: seededAt } } },
    };
    const res = result([memSection('topic', 0.8, 'a fully reworded body')]);
    const plan = planConsolidation({
      current: { memory: '### topic\nold body', user: '' },
      result: res,
      meta,
      params: params(),
    });
    expect(plan.archivedSlugs).toEqual([]);
    expect(plan.nextMeta.keys['MEMORY.md']?.topic.lastSeen).toBe(seededAt);
  });
});

describe('planConsolidation — USER.md exemption (§4.3)', () => {
  it('never archives USER sections when exempt (default)', () => {
    const res = result([], [memSection('anything', 0.0)]);
    const plan = planConsolidation({
      current: { memory: '', user: 'old' },
      result: res,
      meta: emptyMeta(),
      params: params({ exemptUser: true }),
    });
    expect(plan.archivedSlugs).toEqual([]);
    expect(plan.updates.some((u) => u.key === 'USER.md')).toBe(true);
    expect(plan.updates.some((u) => u.key === 'memory-archive.md')).toBe(false);
    // Exempt files are not tracked in the sidecar.
    expect(plan.nextMeta.keys['USER.md']).toBeUndefined();
  });

  it('does decay USER when exemptUser is false', () => {
    const res = result([], [memSection('low', 0.01)]);
    const plan = planConsolidation({
      current: { memory: '', user: 'old' },
      result: res,
      meta: emptyMeta(),
      params: params({ exemptUser: false }),
    });
    expect(plan.archivedSlugs).toEqual(['low']);
    expect(plan.updates.some((u) => u.key === 'memory-archive.md')).toBe(true);
  });

  it('never destroys USER on an empty distillation', () => {
    const res: ConsolidationResult = {
      memory: '',
      user: '',
      memorySections: [],
      userSections: [],
      scored: true,
    };
    const plan = planConsolidation({
      current: { memory: '', user: 'crown jewels' },
      result: res,
      meta: emptyMeta(),
      params: params(),
    });
    expect(plan.updates).toEqual([]);
  });
});

describe('archive block round-trip', () => {
  it('formats and re-parses a block by slug', () => {
    const block = formatArchiveBlock(
      memSection('daughter-priya', 0.9, 'Priya b.2019'),
      'MEMORY.md',
      NOW,
    );
    const archive = `existing\n\n${block}`;
    const blocks = parseArchiveBlocks(archive);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.slug).toBe('daughter-priya');
    expect(blocks[0]?.fromKey).toBe('MEMORY.md');
    expect(blocks[0]?.section).toBe('### daughter-priya\nPriya b.2019');
  });

  it('parses multiple blocks and keeps them separable', () => {
    const a = formatArchiveBlock(memSection('a', 0.1), 'MEMORY.md', NOW);
    const b = formatArchiveBlock(memSection('b', 0.1), 'USER.md', NOW);
    const blocks = parseArchiveBlocks(`${a}\n\n${b}`);
    expect(blocks.map((x) => x.slug)).toEqual(['a', 'b']);
    expect(blocks[1]?.fromKey).toBe('USER.md');
  });
});

describe('parseMemoryMeta — tolerant validation', () => {
  it('returns empty meta for null / garbage / wrong version', () => {
    expect(parseMemoryMeta(null).keys).toEqual({});
    expect(parseMemoryMeta('not json').keys).toEqual({});
    expect(parseMemoryMeta(JSON.stringify({ version: 2, keys: {} })).keys).toEqual({});
  });

  it('parses a valid sidecar and drops malformed entries', () => {
    const raw = JSON.stringify({
      version: 1,
      keys: {
        'MEMORY.md': {
          good: { importance: 0.7, lastSeen: 123 },
          bad: { importance: 'x', lastSeen: 1 },
        },
      },
    });
    const meta = parseMemoryMeta(raw);
    expect(meta.keys['MEMORY.md']).toEqual({ good: { importance: 0.7, lastSeen: 123 } });
  });
});
