import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadRegistry,
  type ProcessEntry,
  type Registry,
  reapStale,
  saveRegistry,
  updateEntry,
  updateEntryIf,
  withRegistryLock,
} from '../registry';

let dataDir: string;

function makeEntry(id: string, patch: Partial<ProcessEntry> = {}): ProcessEntry {
  const now = new Date().toISOString();
  return {
    id,
    name: id,
    pid: 12345,
    command: 'sleep 1',
    cwd: dataDir,
    status: 'running',
    startedAt: now,
    lastTouchedAt: now,
    started_by: 'tester',
    ...patch,
  };
}

beforeEach(() => {
  dataDir = join(tmpdir(), `ethos-reg-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dataDir, { recursive: true });
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('loadRegistry / saveRegistry', () => {
  it('returns empty object when no registry file exists', () => {
    expect(loadRegistry(dataDir)).toEqual({});
  });

  it('round-trips a registry through save and load', () => {
    const reg: Registry = { a: makeEntry('a'), b: makeEntry('b') };
    saveRegistry(dataDir, reg);
    expect(loadRegistry(dataDir)).toEqual(reg);
  });

  it('loads a pre-existing entry that has no started_by field', () => {
    // Registry files written before started_by existed must still deserialize.
    const path = join(dataDir, 'processes', 'registry.json');
    mkdirSync(join(dataDir, 'processes'), { recursive: true });
    const legacy = {
      old: {
        id: 'old',
        name: 'old',
        pid: 111,
        command: 'sleep 1',
        cwd: dataDir,
        status: 'running',
        startedAt: new Date().toISOString(),
        lastTouchedAt: new Date().toISOString(),
      },
    };
    writeFileSync(path, JSON.stringify(legacy), 'utf8');
    const reg = loadRegistry(dataDir);
    expect(reg.old).toBeDefined();
    expect(reg.old?.started_by).toBeUndefined();
  });

  it('returns empty object when the registry file is corrupt', () => {
    saveRegistry(dataDir, { a: makeEntry('a') });
    // overwrite with garbage
    const path = join(dataDir, 'processes', 'registry.json');
    writeFileSync(path, '{not json', 'utf8');
    expect(loadRegistry(dataDir)).toEqual({});
  });
});

describe('updateEntry', () => {
  it('applies a patch and bumps lastTouchedAt', async () => {
    saveRegistry(dataDir, { a: makeEntry('a', { lastTouchedAt: '2000-01-01T00:00:00.000Z' }) });
    await updateEntry(dataDir, 'a', { status: 'exited', exitCode: 0 });
    const entry = loadRegistry(dataDir).a;
    expect(entry?.status).toBe('exited');
    expect(entry?.exitCode).toBe(0);
    expect(new Date(entry?.lastTouchedAt ?? 0).getTime()).toBeGreaterThan(
      new Date('2000-01-01T00:00:00.000Z').getTime(),
    );
  });

  it('is a no-op for an unknown id', async () => {
    saveRegistry(dataDir, { a: makeEntry('a') });
    await updateEntry(dataDir, 'missing', { status: 'killed' });
    expect(loadRegistry(dataDir).missing).toBeUndefined();
  });
});

describe('updateEntryIf', () => {
  it('applies the patch when the predicate passes', async () => {
    saveRegistry(dataDir, { a: makeEntry('a', { status: 'running' }) });
    await updateEntryIf(dataDir, 'a', (e) => e.status === 'running', { status: 'exited' });
    expect(loadRegistry(dataDir).a?.status).toBe('exited');
  });

  it('skips the patch when the predicate fails', async () => {
    // mirrors the spawn-exit-vs-process_stop race: entry already 'killed',
    // so the exit handler's running-only predicate must not clobber it.
    saveRegistry(dataDir, { a: makeEntry('a', { status: 'killed' }) });
    await updateEntryIf(dataDir, 'a', (e) => e.status === 'running', { status: 'exited' });
    expect(loadRegistry(dataDir).a?.status).toBe('killed');
  });
});

describe('reapStale', () => {
  it('drops terminal entries older than 24h', () => {
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const reg: Registry = {
      stale: makeEntry('stale', { status: 'exited', lastTouchedAt: old }),
      fresh: makeEntry('fresh', { status: 'exited' }),
      running: makeEntry('running', { status: 'running', lastTouchedAt: old }),
    };
    const out = reapStale(reg);
    expect(out.stale).toBeUndefined();
    expect(out.fresh).toBeDefined();
    // running is never reaped even if old
    expect(out.running).toBeDefined();
  });
});

describe('withRegistryLock', () => {
  it('runs the callback and returns its value', async () => {
    const result = await withRegistryLock(dataDir, async () => 42);
    expect(result).toBe(42);
  });

  it('releases the lock so a subsequent acquisition succeeds', async () => {
    await withRegistryLock(dataDir, async () => {});
    const lockPath = join(dataDir, 'processes', 'registry.lock');
    expect(existsSync(lockPath)).toBe(false);
    // can acquire again
    await withRegistryLock(dataDir, async () => {});
  });

  it('releases the lock even when the callback throws', async () => {
    await expect(
      withRegistryLock(dataDir, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const lockPath = join(dataDir, 'processes', 'registry.lock');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('serializes concurrent read-modify-write so no entries are lost', async () => {
    const N = 30;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        withRegistryLock(dataDir, async () => {
          const reg = loadRegistry(dataDir);
          reg[`p${i}`] = makeEntry(`p${i}`);
          saveRegistry(dataDir, reg);
        }),
      ),
    );
    const final = loadRegistry(dataDir);
    expect(Object.keys(final)).toHaveLength(N);
    for (let i = 0; i < N; i++) {
      expect(final[`p${i}`]).toBeDefined();
    }
  });
});
