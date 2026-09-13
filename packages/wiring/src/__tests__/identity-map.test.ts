import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsStorage, InMemoryStorage } from '@ethosagent/storage-fs';
import type { Storage } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { currentBootId } from '../backup/holder-identity';
import {
  acquireIdentityMapLock,
  IdentityMap,
  type IdentityMapEntry,
  identityMapLockPath,
} from '../identity-map';

// The lock sentinel is a real file beside the map, so every map here lives under
// a real temporary directory even when its Storage is in-memory.
let root: string;
let dataDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ethos-identity-map-'));
  dataDir = join(root, 'ethos');
  mkdirSync(dataDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function mapPathIn(dir: string): string {
  return join(dir, 'users', 'identity-map.json');
}

describe('IdentityMap', () => {
  it('mints a userId on first resolve', async () => {
    const storage = new InMemoryStorage();
    const map = new IdentityMap({ storage, dataDir });

    const userId = await map.resolve('slack', 'U_A');
    expect(userId).toHaveLength(12);
    expect(/^[a-f0-9]{12}$/.test(userId)).toBe(true);
  });

  it('returns the same userId on repeated resolve for the same pair', async () => {
    const storage = new InMemoryStorage();
    const map = new IdentityMap({ storage, dataDir });

    const first = await map.resolve('slack', 'U_A');
    const second = await map.resolve('slack', 'U_A');
    expect(second).toBe(first);
  });

  it('returns distinct userIds for different platform/user pairs', async () => {
    const storage = new InMemoryStorage();
    const map = new IdentityMap({ storage, dataDir });

    const slackUser = await map.resolve('slack', 'U_A');
    const telegramUser = await map.resolve('telegram', 'T_A');
    expect(slackUser).not.toBe(telegramUser);
  });

  it('listUsers returns all known users', async () => {
    const storage = new InMemoryStorage();
    const map = new IdentityMap({ storage, dataDir });

    await map.resolve('slack', 'U_A', 'Alice');
    await map.resolve('telegram', 'T_B', 'Bob');

    const users = await map.listUsers();
    expect(users).toHaveLength(2);
    expect(users[0].platform).toBe('slack');
    expect(users[0].platformUserId).toBe('U_A');
    expect(users[0].displayLabel).toBe('Alice');
    expect(users[1].platform).toBe('telegram');
    expect(users[1].platformUserId).toBe('T_B');
    expect(users[1].displayLabel).toBe('Bob');
  });

  it('persists entries across IdentityMap instances', async () => {
    const storage = new InMemoryStorage();

    const map1 = new IdentityMap({ storage, dataDir });
    const userId = await map1.resolve('slack', 'U_A');

    // New instance, same storage — should load from disk
    const map2 = new IdentityMap({ storage, dataDir });
    const resolved = await map2.resolve('slack', 'U_A');
    expect(resolved).toBe(userId);
  });

  it('uses default displayLabel when none is provided', async () => {
    const storage = new InMemoryStorage();
    const map = new IdentityMap({ storage, dataDir });

    await map.resolve('slack', 'U_A');
    const users = await map.listUsers();
    expect(users[0].displayLabel).toBe('slack:U_A');
  });
});

describe('IdentityMap — shared file', () => {
  function entry(platform: string, platformUserId: string, userId: string): IdentityMapEntry {
    return {
      platform,
      platformUserId,
      userId,
      displayLabel: `${platform}:${platformUserId}`,
      firstSeenAt: '2026-09-01T10:00:00.000Z',
    };
  }

  async function readMap(storage: Storage): Promise<IdentityMapEntry[]> {
    return JSON.parse((await storage.read(mapPathIn(dataDir))) ?? '[]');
  }

  it('keeps an entry another writer added after the cache loaded when it mints', async () => {
    const storage = new InMemoryStorage();
    const map = new IdentityMap({ storage, dataDir });
    await map.resolve('slack', 'U_A'); // loads + caches the file

    // An operator (or another process) adds an entry while this map is running.
    const onDisk = await readMap(storage);
    await storage.writeAtomic(
      mapPathIn(dataDir),
      JSON.stringify([...onDisk, entry('telegram', '42', 'handaddedid1')]),
    );

    await map.resolve('discord', 'D_B'); // mints

    const after = await readMap(storage);
    expect(after.map((e) => `${e.platform}:${e.platformUserId}`)).toEqual([
      'slack:U_A',
      'telegram:42',
      'discord:D_B',
    ]);
    expect(after.find((e) => e.platform === 'telegram')?.userId).toBe('handaddedid1');
  });

  it('honours a hand edit on the next resolve, without a restart', async () => {
    const storage = new InMemoryStorage();
    const map = new IdentityMap({ storage, dataDir });
    const slackId = await map.resolve('slack', 'U_A');
    const telegramId = await map.resolve('telegram', 'T_A');
    expect(telegramId).not.toBe(slackId);

    // Link: the operator points the telegram identity at the slack userId.
    const linked = (await readMap(storage)).map((e) =>
      e.platform === 'telegram' ? { ...e, userId: slackId } : e,
    );
    await storage.writeAtomic(mapPathIn(dataDir), JSON.stringify(linked));

    expect(await map.resolve('telegram', 'T_A')).toBe(slackId);
  });

  it('does not resurrect an entry the operator removed', async () => {
    const storage = new InMemoryStorage();
    const map = new IdentityMap({ storage, dataDir });
    await map.resolve('slack', 'U_A');
    await map.resolve('telegram', 'T_A');

    const unlinked = (await readMap(storage)).filter((e) => e.platform !== 'telegram');
    await storage.writeAtomic(mapPathIn(dataDir), JSON.stringify(unlinked));
    await map.resolve('discord', 'D_B');

    expect((await readMap(storage)).map((e) => e.platform)).toEqual(['slack', 'discord']);
  });

  it('persists both of two interleaved mints from two maps over one file', async () => {
    const storage = new InMemoryStorage();
    const first = new IdentityMap({ storage, dataDir });
    const second = new IdentityMap({ storage, dataDir });
    // Both caches are loaded (empty) before either mints.
    await Promise.all([first.listUsers(), second.listUsers()]);

    const [a, b] = await Promise.all([
      first.resolve('slack', 'U_A'),
      second.resolve('telegram', 'T_B'),
    ]);

    const after = await readMap(storage);
    expect(after).toHaveLength(2);
    expect(after.find((e) => e.platform === 'slack')?.userId).toBe(a);
    expect(after.find((e) => e.platform === 'telegram')?.userId).toBe(b);
  });

  it('re-merges when a concurrent writer replaces the file with a copy that lacks the mint', async () => {
    // Simulates another PROCESS (no shared in-process queue): it read the file
    // before this mint wrote, and its own write lands right after ours.
    const disk = new InMemoryStorage();
    let raced = false;
    const storage: Storage = Object.assign(Object.create(disk) as Storage, {
      async writeAtomic(path: string, content: string | Uint8Array) {
        await disk.writeAtomic(path, content);
        if (!raced) {
          raced = true;
          await disk.writeAtomic(path, JSON.stringify([entry('telegram', 'T_B', 'otherproc001')]));
        }
      },
    });
    const map = new IdentityMap({ storage, dataDir });

    const userId = await map.resolve('slack', 'U_A');

    const after = await readMap(disk);
    expect(after.map((e) => e.userId).sort()).toEqual(['otherproc001', userId].sort());
  });

  it('adopts the userId another writer minted first for the same identity', async () => {
    const disk = new InMemoryStorage();
    let raced = false;
    const storage: Storage = Object.assign(Object.create(disk) as Storage, {
      async writeAtomic(path: string, content: string | Uint8Array) {
        await disk.writeAtomic(path, content);
        if (!raced) {
          raced = true;
          await disk.writeAtomic(path, JSON.stringify([entry('slack', 'U_A', 'otherproc001')]));
        }
      },
    });
    const map = new IdentityMap({ storage, dataDir });

    expect(await map.resolve('slack', 'U_A')).toBe('otherproc001');
    expect(await readMap(disk)).toHaveLength(1);
  });

  it('refuses to mint over a file it cannot parse, and keeps answering known identities', async () => {
    const storage = new InMemoryStorage();
    const map = new IdentityMap({ storage, dataDir });
    const known = await map.resolve('slack', 'U_A');

    await storage.writeAtomic(mapPathIn(dataDir), '[{"platform": "slack",'); // a half-saved edit

    expect(await map.resolve('slack', 'U_A')).toBe(known);
    await expect(map.resolve('telegram', 'T_B')).rejects.toThrow();
    expect(await storage.read(mapPathIn(dataDir))).toBe('[{"platform": "slack",');
  });
});

describe('IdentityMap — cross-process lock', () => {
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  /** A pid that is definitely not running, so a lock naming it is provably stale. */
  function deadPid(): number {
    for (let p = 4_000_000; p > 100_000; p -= 7919) {
      try {
        process.kill(p, 0);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ESRCH') return p;
      }
    }
    throw new Error('could not find a dead pid');
  }

  /** Plant a lock as another holder would, beside this test's map. */
  function plantLock(body: string): string {
    const lockPath = identityMapLockPath(mapPathIn(dataDir));
    mkdirSync(join(dataDir, 'users'), { recursive: true });
    writeFileSync(lockPath, body);
    return lockPath;
  }

  /** A holder that is provably alive: this very worker, from this boot. */
  const liveBody = () => JSON.stringify({ token: 'live', pid: process.pid, boot: currentBootId() });

  it('waits while another holder owns the lock, then mints once it is released', async () => {
    const storage = new InMemoryStorage();
    const map = new IdentityMap({ storage, dataDir });
    const lockPath = plantLock(liveBody());

    let settled = false;
    const minting = map.resolve('slack', 'U_A').finally(() => {
      settled = true;
    });
    await sleep(200);
    expect(settled).toBe(false);
    expect(await storage.read(mapPathIn(dataDir))).toBeNull(); // nothing written without the lock

    unlinkSync(lockPath);
    const userId = await minting;

    const onDisk: IdentityMapEntry[] = JSON.parse((await storage.read(mapPathIn(dataDir))) ?? '[]');
    expect(onDisk.map((e) => e.userId)).toEqual([userId]);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('takes over a lock left behind by a process that is gone', async () => {
    const storage = new InMemoryStorage();
    const map = new IdentityMap({ storage, dataDir });
    const lockPath = plantLock(
      JSON.stringify({ token: 'abandoned', pid: deadPid(), boot: currentBootId() }),
    );

    const userId = await map.resolve('slack', 'U_A');

    expect(userId).toHaveLength(12);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('takes over a lock with no readable holder only once it is old', async () => {
    const lockPath = plantLock(''); // a holder killed between the create and the write

    // Fresh: it may be a holder between its `wx` create and its write, so wait.
    await expect(acquireIdentityMapLock(lockPath, 150)).rejects.toThrow(/is still held/);
    expect(readFileSync(lockPath, 'utf-8')).toBe('');

    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);
    const release = await acquireIdentityMapLock(lockPath, 150);
    release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('refuses, writes nothing, and leaves a live holder alone when the wait runs out', async () => {
    const body = liveBody();
    const lockPath = plantLock(body);

    await expect(acquireIdentityMapLock(lockPath, 150)).rejects.toThrow(
      new RegExp(`held by process ${process.pid}`),
    );
    expect(readFileSync(lockPath, 'utf-8')).toBe(body);
  });

  it('persists both entries when two minters without a shared in-process queue interleave', async () => {
    // Two spellings of one directory: the in-process mint queue is keyed by the
    // path STRING, so these two maps do not share it — exactly like two
    // processes. Only the file lock stands between them.
    const linkDir = join(root, 'ethos-link');
    symlinkSync(dataDir, linkDir);
    const disk = new FsStorage();
    const second = new IdentityMap({ storage: disk, dataDir: linkDir });

    let reads = 0;
    let secondMint: Promise<string> | undefined;
    const pausing: Storage = Object.assign(Object.create(disk) as Storage, {
      async read(path: string) {
        const content = await disk.read(path);
        // Read #1 is the lookup; read #2 is the mint's re-read. Between that
        // re-read and its write, let the other minter run to completion if it can.
        if (path === mapPathIn(dataDir) && ++reads === 2) {
          secondMint = second.resolve('telegram', 'T_B');
          await sleep(300);
        }
        return content;
      },
    });
    const first = new IdentityMap({ storage: pausing, dataDir });

    const a = await first.resolve('slack', 'U_A');
    const b = await secondMint;

    const onDisk: IdentityMapEntry[] = JSON.parse((await disk.read(mapPathIn(dataDir))) ?? '[]');
    expect(onDisk.map((e) => e.userId).sort()).toEqual([a, b].sort());
  });

  it('releases the lock when the write fails', async () => {
    const disk = new InMemoryStorage();
    let fail = true;
    const storage: Storage = Object.assign(Object.create(disk) as Storage, {
      async writeAtomic(path: string, content: string | Uint8Array) {
        if (fail) throw new Error('ENOSPC: no space left on device');
        await disk.writeAtomic(path, content);
      },
    });
    const map = new IdentityMap({ storage, dataDir });
    const lockPath = identityMapLockPath(mapPathIn(dataDir));

    await expect(map.resolve('slack', 'U_A')).rejects.toThrow(/ENOSPC/);
    expect(existsSync(lockPath)).toBe(false);

    // Were it still held by this (live) process, this would wait out the bound.
    fail = false;
    expect(await map.resolve('slack', 'U_A')).toHaveLength(12);
  });
});
