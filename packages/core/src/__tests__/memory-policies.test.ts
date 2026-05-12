// Unit tests for Phase 4 memory policy decorators.
//
// Uses InMemoryMemoryProvider — a simple Map-backed MemoryProvider that stores
// both content and an mtime per entry.  Policies are tested in isolation with
// no filesystem dependency.

import type {
  ListOpts,
  MemoryContext,
  MemoryEntry,
  MemoryEntryRef,
  MemoryProvider,
  MemorySnapshot,
  MemoryUpdate,
  SearchOpts,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import {
  EagerPrefetchPolicy,
  LastWriteWinsPolicy,
  LazyOnDemandPolicy,
  MemoryConflictError,
} from '../memory-policies';

// ---------------------------------------------------------------------------
// InMemoryMemoryProvider — test helper
// ---------------------------------------------------------------------------

interface StoredEntry {
  content: string;
  mtime: number;
}

/**
 * Map-backed MemoryProvider for unit testing.  Supports manual mtime
 * overrides via `setMtime()` to simulate concurrent writes.
 */
class InMemoryMemoryProvider implements MemoryProvider {
  private readonly store = new Map<string, StoredEntry>();
  private clock = 1000;

  /** Write a key directly, bypassing sync() (for test setup). */
  seed(scopeId: string, key: string, content: string, mtime?: number): void {
    const compoundKey = `${scopeId}:${key}`;
    this.store.set(compoundKey, { content, mtime: mtime ?? ++this.clock });
  }

  /** Advance the internal clock and update a key's mtime (simulates external write). */
  setMtime(scopeId: string, key: string, mtime: number): void {
    const compoundKey = `${scopeId}:${key}`;
    const existing = this.store.get(compoundKey);
    if (existing) {
      this.store.set(compoundKey, { ...existing, mtime });
    }
  }

  async prefetch(ctx: MemoryContext): Promise<MemorySnapshot | null> {
    const entries: Array<{ key: string; content: string }> = [];
    for (const [k, v] of this.store) {
      if (k.startsWith(`${ctx.scopeId}:`)) {
        entries.push({ key: k.slice(ctx.scopeId.length + 1), content: v.content });
      }
    }
    return entries.length > 0 ? { entries } : null;
  }

  async read(key: string, ctx: MemoryContext): Promise<MemoryEntry | null> {
    const stored = this.store.get(`${ctx.scopeId}:${key}`);
    if (!stored) return null;
    return { key, content: stored.content, metadata: { lastUpdatedAt: stored.mtime } };
  }

  async search(query: string, ctx: MemoryContext, opts?: SearchOpts): Promise<MemoryEntry[]> {
    const results: MemoryEntry[] = [];
    const limit = opts?.limit ?? Number.POSITIVE_INFINITY;
    for (const [k, v] of this.store) {
      if (results.length >= limit) break;
      if (!k.startsWith(`${ctx.scopeId}:`)) continue;
      if (v.content.includes(query)) {
        const key = k.slice(ctx.scopeId.length + 1);
        results.push({ key, content: v.content, metadata: { lastUpdatedAt: v.mtime } });
      }
    }
    return results;
  }

  async sync(updates: MemoryUpdate[], ctx: MemoryContext): Promise<void> {
    for (const u of updates) {
      const compoundKey = `${ctx.scopeId}:${u.key}`;
      if (u.action === 'delete') {
        this.store.delete(compoundKey);
      } else if (u.action === 'add') {
        const existing = this.store.get(compoundKey);
        const content = existing ? `${existing.content}\n${u.content}` : u.content;
        this.store.set(compoundKey, { content, mtime: ++this.clock });
      } else if (u.action === 'replace') {
        this.store.set(compoundKey, { content: u.content, mtime: ++this.clock });
      } else if (u.action === 'remove') {
        const existing = this.store.get(compoundKey);
        if (existing) {
          const lines = existing.content.split('\n').filter((l) => !l.includes(u.substringMatch));
          this.store.set(compoundKey, { content: lines.join('\n'), mtime: ++this.clock });
        }
      }
    }
  }

  async list(ctx: MemoryContext, opts?: ListOpts): Promise<MemoryEntryRef[]> {
    const refs: MemoryEntryRef[] = [];
    for (const [k, v] of this.store) {
      if (!k.startsWith(`${ctx.scopeId}:`)) continue;
      const key = k.slice(ctx.scopeId.length + 1);
      refs.push({ key, metadata: { lastUpdatedAt: v.mtime } });
    }
    if (opts?.limit !== undefined) return refs.slice(0, opts.limit);
    return refs;
  }
}

// ---------------------------------------------------------------------------
// Shared test context
// ---------------------------------------------------------------------------

function makeCtx(scopeId = 'test:scope'): MemoryContext {
  return { scopeId, sessionId: 'sess', sessionKey: 'sess', platform: 'test', workingDir: '/tmp' };
}

// ---------------------------------------------------------------------------
// EagerPrefetchPolicy
// ---------------------------------------------------------------------------

describe('EagerPrefetchPolicy', () => {
  it('delegates prefetch to the inner provider', async () => {
    const inner = new InMemoryMemoryProvider();
    inner.seed('test:scope', 'MEMORY.md', '# memory');
    const policy = new EagerPrefetchPolicy(inner);
    const snap = await policy.prefetch(makeCtx());
    expect(snap).not.toBeNull();
    expect(snap?.entries[0].key).toBe('MEMORY.md');
  });

  it('delegates read', async () => {
    const inner = new InMemoryMemoryProvider();
    inner.seed('test:scope', 'notes.md', 'hello');
    const policy = new EagerPrefetchPolicy(inner);
    const entry = await policy.read('notes.md', makeCtx());
    expect(entry?.content).toBe('hello');
  });

  it('delegates sync', async () => {
    const inner = new InMemoryMemoryProvider();
    const policy = new EagerPrefetchPolicy(inner);
    await policy.sync([{ action: 'add', key: 'foo.md', content: 'bar' }], makeCtx());
    const entry = await inner.read('foo.md', makeCtx());
    expect(entry?.content).toBe('bar');
  });

  it('delegates list', async () => {
    const inner = new InMemoryMemoryProvider();
    inner.seed('test:scope', 'a.md', 'content');
    const policy = new EagerPrefetchPolicy(inner);
    const refs = await policy.list(makeCtx());
    expect(refs.map((r) => r.key)).toContain('a.md');
  });

  it('delegates search', async () => {
    const inner = new InMemoryMemoryProvider();
    inner.seed('test:scope', 'x.md', 'hello world');
    const policy = new EagerPrefetchPolicy(inner);
    const results = await policy.search('world', makeCtx());
    expect(results.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// LazyOnDemandPolicy
// ---------------------------------------------------------------------------

describe('LazyOnDemandPolicy', () => {
  it('prefetch always returns null', async () => {
    const inner = new InMemoryMemoryProvider();
    inner.seed('team:alpha', 'decisions.md', '# Decisions\nDo X');
    const policy = new LazyOnDemandPolicy(inner);
    const snap = await policy.prefetch(makeCtx('team:alpha'));
    expect(snap).toBeNull();
  });

  it('delegates read through', async () => {
    const inner = new InMemoryMemoryProvider();
    inner.seed('team:alpha', 'decisions.md', '# Decisions');
    const policy = new LazyOnDemandPolicy(inner);
    const entry = await policy.read('decisions.md', makeCtx('team:alpha'));
    expect(entry?.content).toBe('# Decisions');
  });

  it('delegates sync through', async () => {
    const inner = new InMemoryMemoryProvider();
    const policy = new LazyOnDemandPolicy(inner);
    await policy.sync(
      [{ action: 'add', key: 'onboarding.md', content: '# Onboarding' }],
      makeCtx('team:alpha'),
    );
    const refs = await inner.list(makeCtx('team:alpha'));
    expect(refs.map((r) => r.key)).toContain('onboarding.md');
  });

  it('delegates list through', async () => {
    const inner = new InMemoryMemoryProvider();
    inner.seed('team:alpha', 'decisions.md', 'content');
    inner.seed('team:alpha', 'onboarding.md', 'content');
    const policy = new LazyOnDemandPolicy(inner);
    const refs = await policy.list(makeCtx('team:alpha'));
    expect(refs.length).toBe(2);
  });

  it('delegates search through', async () => {
    const inner = new InMemoryMemoryProvider();
    inner.seed('team:alpha', 'decisions.md', 'we decided to use TypeScript');
    const policy = new LazyOnDemandPolicy(inner);
    const results = await policy.search('TypeScript', makeCtx('team:alpha'));
    expect(results.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// LastWriteWinsPolicy
// ---------------------------------------------------------------------------

describe('LastWriteWinsPolicy', () => {
  it('allows sync when the entry has not been read (blind add)', async () => {
    const inner = new InMemoryMemoryProvider();
    const policy = new LastWriteWinsPolicy(inner);
    // No prior read — should pass through unconditionally.
    await expect(
      policy.sync([{ action: 'add', key: 'new.md', content: 'hello' }], makeCtx('team:alpha')),
    ).resolves.toBeUndefined();
    const entry = await inner.read('new.md', makeCtx('team:alpha'));
    expect(entry?.content).toBe('hello');
  });

  it('allows sync when the entry has not changed since last read', async () => {
    const inner = new InMemoryMemoryProvider();
    inner.seed('team:alpha', 'decisions.md', '# Decisions', 5000);
    const policy = new LastWriteWinsPolicy(inner);
    // Read — records mtime 5000.
    await policy.read('decisions.md', makeCtx('team:alpha'));
    // No external write; mtime is still 5000.
    await expect(
      policy.sync(
        [{ action: 'add', key: 'decisions.md', content: 'new line' }],
        makeCtx('team:alpha'),
      ),
    ).resolves.toBeUndefined();
  });

  it('rejects sync with MemoryConflictError when entry was modified after last read', async () => {
    const inner = new InMemoryMemoryProvider();
    inner.seed('team:alpha', 'decisions.md', '# Decisions', 5000);
    const policy = new LastWriteWinsPolicy(inner);

    // Read — records mtime 5000.
    await policy.read('decisions.md', makeCtx('team:alpha'));

    // Simulate external write advancing the mtime to 9000.
    inner.setMtime('team:alpha', 'decisions.md', 9000);

    await expect(
      policy.sync(
        [{ action: 'add', key: 'decisions.md', content: 'stale write' }],
        makeCtx('team:alpha'),
      ),
    ).rejects.toThrow(MemoryConflictError);
  });

  it('MemoryConflictError carries the correct key and scope', async () => {
    const inner = new InMemoryMemoryProvider();
    inner.seed('team:alpha', 'onboarding.md', '# Onboarding', 1000);
    const policy = new LastWriteWinsPolicy(inner);
    await policy.read('onboarding.md', makeCtx('team:alpha'));
    inner.setMtime('team:alpha', 'onboarding.md', 2000);

    let caught: MemoryConflictError | null = null;
    try {
      await policy.sync(
        [{ action: 'replace', key: 'onboarding.md', content: 'replaced' }],
        makeCtx('team:alpha'),
      );
    } catch (err) {
      if (err instanceof MemoryConflictError) caught = err;
    }

    expect(caught).not.toBeNull();
    expect(caught?.key).toBe('onboarding.md');
    expect(caught?.scopeId).toBe('team:alpha');
    expect(caught?.currentAt).toBe(2000);
    expect(caught?.recordedAt).toBe(1000);
  });

  it('integration: two concurrent writers — first succeeds, second gets conflict', async () => {
    const inner = new InMemoryMemoryProvider();
    inner.seed('team:beta', 'decisions.md', '# Decisions', 1000);

    const agentA = new LastWriteWinsPolicy(inner);
    const agentB = new LastWriteWinsPolicy(inner);
    const ctx = makeCtx('team:beta');

    // Both agents read the same entry at mtime 1000.
    await agentA.read('decisions.md', ctx);
    await agentB.read('decisions.md', ctx);

    // Agent A writes first — succeeds and advances mtime.
    await expect(
      agentA.sync([{ action: 'add', key: 'decisions.md', content: 'Agent A was here' }], ctx),
    ).resolves.toBeUndefined();

    // After Agent A's sync, the inner store has a newer mtime.
    // Agent B's read-timestamp (1000) is now stale — its write is rejected.
    await expect(
      agentB.sync([{ action: 'add', key: 'decisions.md', content: 'Agent B was here' }], ctx),
    ).rejects.toThrow(MemoryConflictError);

    // The winning write from Agent A is preserved.
    const final = await inner.read('decisions.md', ctx);
    expect(final?.content).toContain('Agent A was here');
    expect(final?.content).not.toContain('Agent B was here');
  });

  it('delegates list through', async () => {
    const inner = new InMemoryMemoryProvider();
    inner.seed('team:alpha', 'a.md', 'content');
    const policy = new LastWriteWinsPolicy(inner);
    const refs = await policy.list(makeCtx('team:alpha'));
    expect(refs.map((r) => r.key)).toContain('a.md');
  });

  it('delegates search through', async () => {
    const inner = new InMemoryMemoryProvider();
    inner.seed('team:alpha', 'search.md', 'find me');
    const policy = new LastWriteWinsPolicy(inner);
    const results = await policy.search('find me', makeCtx('team:alpha'));
    expect(results.length).toBe(1);
  });

  it('read returns entry from inner provider', async () => {
    const inner = new InMemoryMemoryProvider();
    inner.seed('team:alpha', 'data.md', 'content here', 3000);
    const policy = new LastWriteWinsPolicy(inner);
    const entry = await policy.read('data.md', makeCtx('team:alpha'));
    expect(entry?.content).toBe('content here');
    expect(entry?.metadata?.lastUpdatedAt).toBe(3000);
  });

  it('does not record mtime when entry does not exist', async () => {
    const inner = new InMemoryMemoryProvider();
    const policy = new LastWriteWinsPolicy(inner);
    // Read non-existent key — no mtime recorded.
    const entry = await policy.read('missing.md', makeCtx('team:alpha'));
    expect(entry).toBeNull();
    // Subsequent sync should pass through (no timestamp to check against).
    await expect(
      policy.sync([{ action: 'add', key: 'missing.md', content: 'new' }], makeCtx('team:alpha')),
    ).resolves.toBeUndefined();
  });

  it('records mtime from search when no prior read exists, enabling conflict detection', async () => {
    const inner = new InMemoryMemoryProvider();
    inner.seed('team:alpha', 'decisions.md', 'we use TypeScript', 5000);
    const policy = new LastWriteWinsPolicy(inner);

    // Establish timestamp via search (no prior read).
    const results = await policy.search('TypeScript', makeCtx('team:alpha'));
    expect(results.length).toBe(1);

    // Simulate external write advancing mtime.
    inner.setMtime('team:alpha', 'decisions.md', 8000);

    // sync should detect the conflict because search recorded mtime 5000.
    await expect(
      policy.sync(
        [{ action: 'add', key: 'decisions.md', content: 'extra line' }],
        makeCtx('team:alpha'),
      ),
    ).rejects.toThrow(MemoryConflictError);
  });

  it('does not overwrite a prior read mtime with a later search result (stale-state laundering guard)', async () => {
    const inner = new InMemoryMemoryProvider();
    inner.seed('team:alpha', 'decisions.md', 'we use TypeScript', 1000);
    const policy = new LastWriteWinsPolicy(inner);

    // Caller reads at mtime 1000 — this is the authoritative baseline.
    await policy.read('decisions.md', makeCtx('team:alpha'));

    // External writer bumps mtime to 2000.
    inner.setMtime('team:alpha', 'decisions.md', 2000);

    // Caller searches and gets the entry at the NEW mtime 2000.
    // search() must NOT overwrite the recorded read mtime (1000).
    await policy.search('TypeScript', makeCtx('team:alpha'));

    // sync should still detect the conflict (recorded baseline is 1000, current is 2000).
    await expect(
      policy.sync(
        [{ action: 'add', key: 'decisions.md', content: 'stale write' }],
        makeCtx('team:alpha'),
      ),
    ).rejects.toThrow(MemoryConflictError);
  });
});
