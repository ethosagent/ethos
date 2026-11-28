import { join } from 'node:path';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { BoundaryError } from '@ethosagent/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { diffSkillVersions, SkillHistory } from '../skill-history';

const DATA = '/data';
const DEST = join(DATA, 'skills', 'tidy.md');
const PERSONALITY_DEST = join(DATA, 'personalities', 'coach', 'skills', 'tidy.md');

describe('SkillHistory', () => {
  let storage: InMemoryStorage;
  let history: SkillHistory;
  let clock: number;

  beforeEach(async () => {
    storage = new InMemoryStorage();
    clock = Date.parse('2026-01-01T00:00:00Z');
    history = new SkillHistory({ storage, dataDir: DATA, now: () => (clock += 1000) });
    await storage.mkdir(join(DATA, 'skills'));
  });

  describe('writeHuman', () => {
    it('records a baseline for pre-existing bytes, then the new version', async () => {
      await storage.write(DEST, 'v0\n');
      const { versionId } = await history.writeHuman(DEST, 'v1\n', {
        source: 'web-edit',
        actor: 'web',
      });
      const rows = await history.versions(DEST);
      expect(rows.map((r) => r.source)).toEqual(['external', 'web-edit']);
      expect(rows[1]?.versionId).toBe(versionId);
      expect(rows[1]?.actor).toBe('web');
      expect(await storage.read(DEST)).toBe('v1\n');
    });

    it('records only the new version when nothing was live', async () => {
      await history.writeHuman(DEST, 'v1\n', { source: 'web-edit', actor: 'web' });
      const rows = await history.versions(DEST);
      expect(rows.map((r) => r.source)).toEqual(['web-edit']);
    });

    it('round-trips version bytes and diffs two versions', async () => {
      await storage.write(DEST, 'a\nb\n');
      const first = await history.writeHuman(DEST, 'a\nc\n', { source: 'web-edit', actor: 'web' });
      const rows = await history.versions(DEST);
      const baseline = rows[0];
      if (!baseline) throw new Error('no baseline');
      expect(await history.readVersion(DEST, baseline.versionId)).toBe('a\nb\n');
      expect(await history.readVersion(DEST, first.versionId)).toBe('a\nc\n');
      expect(await history.readVersion(DEST, 'nope')).toBeNull();
      const diff = diffSkillVersions('a\nb\n', 'a\nc\n');
      expect(diff).toContain('-b');
      expect(diff).toContain('+c');
      expect(diff).toContain(' a');
    });

    it('records a tombstone on delete and keeps the bytes restorable', async () => {
      await history.writeHuman(DEST, 'v1\n', { source: 'web-edit', actor: 'web' });
      const del = await history.writeHuman(DEST, null, { source: 'web-edit', actor: 'web' });
      expect(await storage.exists(DEST)).toBe(false);
      const rows = await history.versions(DEST);
      expect(rows.at(-1)?.hash).toBeNull();
      expect(await history.readVersion(DEST, del.versionId)).toBeNull();
      const first = rows[0];
      if (!first) throw new Error('no first row');
      await history.restore(DEST, first.versionId, 'web');
      expect(await storage.read(DEST)).toBe('v1\n');
    });

    it('restore appends a restore row with restoredFrom, never rewriting history', async () => {
      await history.writeHuman(DEST, 'v1\n', { source: 'web-edit', actor: 'web' });
      await history.writeHuman(DEST, 'v2\n', { source: 'web-edit', actor: 'web' });
      const before = await history.versions(DEST);
      const target = before[0];
      if (!target) throw new Error('missing');
      await history.restore(DEST, target.versionId, 'cli');
      const after = await history.versions(DEST);
      expect(after.length).toBe(before.length + 1);
      expect(after.slice(0, before.length)).toEqual(before);
      const last = after.at(-1);
      expect(last?.source).toBe('restore');
      expect(last?.restoredFrom).toBe(target.versionId);
      expect(last?.actor).toBe('cli');
      expect(await storage.read(DEST)).toBe('v1\n');
    });

    it('restoring an unknown version throws', async () => {
      await expect(history.restore(DEST, 'nope', 'cli')).rejects.toThrow(/version/i);
    });

    it('keeps 50 versions and always the head', async () => {
      for (let i = 0; i < 60; i++) {
        await history.writeHuman(DEST, `v${i}\n`, { source: 'web-edit', actor: 'web' });
      }
      const rows = await history.versions(DEST);
      expect(rows.length).toBe(50);
      expect(rows.at(-1)?.hash).not.toBeNull();
      const head = rows.at(-1);
      if (!head) throw new Error('no head');
      expect(await history.readVersion(DEST, head.versionId)).toBe('v59\n');
      const blobs = (await storage.list(join(DATA, 'skills', '.history', 'tidy'))).filter((n) =>
        n.endsWith('.md'),
      );
      expect(blobs.length).toBe(50);
    });

    it('does not prune a version a kept restore row points to', async () => {
      await history.writeHuman(DEST, 'v0\n', { source: 'web-edit', actor: 'web' });
      const first = (await history.versions(DEST))[0];
      if (!first) throw new Error('missing');
      for (let i = 1; i < 50; i++) {
        await history.writeHuman(DEST, `v${i}\n`, { source: 'web-edit', actor: 'web' });
      }
      await history.restore(DEST, first.versionId, 'web');
      const rows = await history.versions(DEST);
      expect(rows.some((r) => r.versionId === first.versionId)).toBe(true);
      expect(await history.readVersion(DEST, first.versionId)).toBe('v0\n');
    });

    it('works for a personality-scoped skill', async () => {
      await storage.mkdir(join(DATA, 'personalities', 'coach', 'skills'));
      await history.writeHuman(PERSONALITY_DEST, 'p\n', { source: 'web-import', actor: 'web' });
      expect((await history.versions(PERSONALITY_DEST)).map((r) => r.source)).toEqual([
        'web-import',
      ]);
    });
  });

  describe('path validation', () => {
    it.each([
      join(DATA, 'elsewhere', 'tidy.md'),
      join(DATA, 'skills', 'nested', 'tidy.md'),
      join(DATA, 'skills', 'tidy.txt'),
      join(DATA, 'skills', '.hidden.md'),
      join(DATA, 'skills', '..md'),
      join(DATA, 'skills', 'Tidy.md'),
      join(DATA, 'personalities', 'Bad Id', 'skills', 'tidy.md'),
      join(DATA, 'personalities', 'coach', 'memory', 'tidy.md'),
      '/etc/passwd',
    ])('refuses %s', async (dest) => {
      await expect(
        history.writeHuman(dest, 'x', { source: 'web-edit', actor: 'w' }),
      ).rejects.toBeInstanceOf(BoundaryError);
      await expect(history.versions(dest)).rejects.toBeInstanceOf(BoundaryError);
      await expect(history.isLocked(dest)).rejects.toBeInstanceOf(BoundaryError);
    });
  });

  describe('drift capture (D10)', () => {
    it('records live bytes changed behind its back as external before the next write', async () => {
      await history.writeHuman(DEST, 'v1\n', { source: 'web-edit', actor: 'web' });
      await storage.write(DEST, 'edited in an editor\n');
      await history.writeHuman(DEST, 'v2\n', { source: 'web-edit', actor: 'web' });
      const rows = await history.versions(DEST);
      expect(rows.map((r) => r.source)).toEqual(['web-edit', 'external', 'web-edit']);
      const external = rows[1];
      if (!external) throw new Error('missing');
      expect(await history.readVersion(DEST, external.versionId)).toBe('edited in an editor\n');
    });

    it('versions() alone captures a change', async () => {
      await history.writeHuman(DEST, 'v1\n', { source: 'web-edit', actor: 'web' });
      await storage.write(DEST, 'changed\n');
      const rows = await history.versions(DEST);
      expect(rows.map((r) => r.source)).toEqual(['web-edit', 'external']);
      // idempotent
      expect((await history.versions(DEST)).length).toBe(2);
    });

    it('versions() on a skill with no history records one external baseline', async () => {
      await storage.write(DEST, 'hand written\n');
      const rows = await history.versions(DEST);
      expect(rows.length).toBe(1);
      expect(rows[0]?.source).toBe('external');
      expect((await history.versions(DEST)).length).toBe(1);
    });

    it('records an external tombstone when the file was removed outside Ethos', async () => {
      await history.writeHuman(DEST, 'v1\n', { source: 'web-edit', actor: 'web' });
      await storage.remove(DEST);
      const rows = await history.versions(DEST);
      expect(rows.at(-1)?.source).toBe('external');
      expect(rows.at(-1)?.hash).toBeNull();
    });

    it('returns an empty timeline for a skill that never existed', async () => {
      expect(await history.versions(DEST)).toEqual([]);
    });
  });

  describe('summary — a read that never writes', () => {
    const treeSize = async () => Object.keys(await snapshotTree(storage)).length;

    it('reports nothing for a skill that never existed, and writes nothing', async () => {
      expect(await history.summary(DEST)).toEqual({ locked: false, versionCount: 0 });
      expect(await storage.exists(join(DATA, 'skills', '.history'))).toBe(false);
    });

    it('counts the baseline an outside file will get, without recording it', async () => {
      await storage.write(DEST, 'by hand\n');
      expect(await history.summary(DEST)).toEqual({ locked: false, versionCount: 1 });
      expect(await storage.exists(join(DATA, 'skills', '.history'))).toBe(false);
    });

    it('counts recorded rows plus one pending outside edit, and matches versions() afterwards', async () => {
      await history.writeHuman(DEST, 'v1\n', { source: 'web-edit', actor: 'web' });
      expect(await history.summary(DEST)).toEqual({ locked: false, versionCount: 1 });
      await storage.write(DEST, 'edited\n');
      const before = await snapshotTree(storage);
      expect(await history.summary(DEST)).toEqual({ locked: false, versionCount: 2 });
      expect(await snapshotTree(storage)).toEqual(before);
      expect((await history.versions(DEST)).length).toBe(2);
    });

    it('reports the lock', async () => {
      await history.setLock(DEST, true, 'cli');
      expect((await history.summary(DEST)).locked).toBe(true);
    });

    it('does not touch storage for a listing', async () => {
      await storage.write(DEST, 'by hand\n');
      const n = await treeSize();
      await history.summary(DEST);
      expect(await treeSize()).toBe(n);
    });
  });

  describe('lock (D1, D5)', () => {
    it('is unlocked by default and setLock persists in the sidecar', async () => {
      expect(await history.isLocked(DEST)).toBe(false);
      await history.setLock(DEST, true, 'cli');
      expect(await history.isLocked(DEST)).toBe(true);
      const raw = await storage.read(join(DATA, 'skills', '.history', 'tidy', 'lock.json'));
      expect(JSON.parse(raw ?? '{}')).toMatchObject({ locked: true, changedBy: 'cli' });
      await history.setLock(DEST, false, 'cli');
      expect(await history.isLocked(DEST)).toBe(false);
    });

    it('writeAgentAuthored on a locked skill returns locked and changes no byte', async () => {
      await history.writeHuman(DEST, 'mine\n', { source: 'web-edit', actor: 'web' });
      await history.setLock(DEST, true, 'cli');
      const snapshot = await snapshotTree(storage);
      const result = await history.writeAgentAuthored(DEST, 'agent\n', {
        actor: 'nightly',
        candidateId: 'c1',
      });
      expect(result).toEqual({ ok: false, code: 'locked' });
      expect(await snapshotTree(storage)).toEqual(snapshot);
      expect(await storage.read(DEST)).toBe('mine\n');
    });

    it('writeAgentAuthored on an unlocked skill writes and returns the version id', async () => {
      const result = await history.writeAgentAuthored(DEST, 'agent\n', {
        actor: 'nightly',
        candidateId: 'c1',
      });
      expect(result.ok).toBe(true);
      const row = (await history.versions(DEST)).at(-1);
      expect(row?.source).toBe('learning');
      expect(row?.candidateId).toBe('c1');
      if (result.ok) expect(row?.versionId).toBe(result.versionId);
    });

    it('writeHuman on a locked skill still succeeds', async () => {
      await history.setLock(DEST, true, 'cli');
      await history.writeHuman(DEST, 'human\n', { source: 'web-edit', actor: 'web' });
      expect(await storage.read(DEST)).toBe('human\n');
    });

    it('a restore on a locked skill still succeeds (it is a human verb)', async () => {
      await history.writeHuman(DEST, 'v1\n', { source: 'web-edit', actor: 'web' });
      await history.writeHuman(DEST, 'v2\n', { source: 'web-edit', actor: 'web' });
      await history.setLock(DEST, true, 'cli');
      const first = (await history.versions(DEST))[0];
      if (!first) throw new Error('missing');
      await history.restore(DEST, first.versionId, 'cli');
      expect(await storage.read(DEST)).toBe('v1\n');
    });
  });
});

async function snapshotTree(storage: InMemoryStorage): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (dir: string): Promise<void> => {
    for (const e of await storage.listEntries(dir)) {
      const p = join(dir, e.name);
      if (e.isDir) await walk(p);
      else out[p] = (await storage.read(p)) ?? '';
    }
  };
  await walk('/data');
  return out;
}
