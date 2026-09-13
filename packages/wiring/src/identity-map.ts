import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Storage } from '@ethosagent/types';
import { acquireSentinelLock } from './backup/sentinel-lock';

export interface IdentityMapEntry {
  platform: string;
  platformUserId: string;
  userId: string;
  displayLabel: string;
  firstSeenAt: string;
}

export interface IdentityMapOptions {
  storage: Storage;
  dataDir: string; // ~/.ethos
}

/** Mint attempts before giving up on seeing our entry survive a concurrent writer. */
const MAX_MINT_ATTEMPTS = 3;

/**
 * Serializes mints against one map file within this process. Keyed by path,
 * not by instance: `ethos serve` builds more than one IdentityMap over its own
 * `FsStorage`, and two instances in one process must not race each other.
 *
 * The file lock below would serialize them too, but by polling against a
 * deadline: a burst of new senders in one process would spend the lock's bounded
 * wait on each other. Queued here, a mint starts that wait only once it reaches
 * the head of its own process's queue, so the wait measures OTHER processes.
 */
const mintQueues = new Map<string, Promise<unknown>>();

/**
 * `~/.ethos/users/identity-map.json` — platform identity → opaque userId.
 *
 * The file is shared with operators (who edit it by hand to link or unlink
 * identities) and with every other process that holds an IdentityMap, so this
 * class never writes back a copy it merely remembers:
 *
 * - Lookups re-read the file whenever its mtime has moved, so a hand edit or
 *   another process's mint is seen on the next resolve, not the next restart.
 * - A mint holds `identity-map.json.lock` (`acquireIdentityMapLock`) across the
 *   whole of its re-read → merge → `writeAtomic` → read-back, so no other
 *   IdentityMap, in this process or any other on this machine, writes between
 *   this mint's re-read and its rename.
 * - Under that lock the file is re-read and written back as that disk content
 *   plus the ONE new entry. Every entry already on disk is kept exactly as it is
 *   there; an entry an operator deleted stays deleted.
 * - If the re-read already holds the identity (another writer minted it first),
 *   that userId is adopted instead of minting a second one.
 * - After writing, the file is read back; if it lacks the entry, the merge is
 *   redone. Other IdentityMaps cannot cause that any more — they wait on the
 *   lock — but an operator's editor and a process running a build from before
 *   the lock do not take it, and they still can.
 *
 * LIMITATIONS, stated rather than hidden: the lock is advisory, so a hand edit
 * saved from a copy read before a mint still replaces that mint whenever it lands
 * after the read-back. And it is sound only among processes on ONE machine,
 * sharing a filesystem whose exclusive create is reliable — see
 * `acquireIdentityMapLock`.
 */
export class IdentityMap {
  private entries: IdentityMapEntry[] | null = null;
  private loadedMtime: number | null = null;
  private readonly mapPath: string;

  constructor(private readonly opts: IdentityMapOptions) {
    this.mapPath = join(opts.dataDir, 'users', 'identity-map.json');
  }

  async resolve(platform: string, platformUserId: string, displayLabel?: string): Promise<string> {
    const existing = findEntry(await this.load(), platform, platformUserId);
    if (existing) return existing.userId;
    return await this.enqueueMint(() => this.mint(platform, platformUserId, displayLabel));
  }

  async listUsers(): Promise<IdentityMapEntry[]> {
    return await this.load();
  }

  /** Cached entries, refreshed whenever the file's mtime differs from the last read. */
  private async load(): Promise<IdentityMapEntry[]> {
    const mtime = await this.opts.storage.mtime(this.mapPath);
    if (this.entries && mtime === this.loadedMtime) return this.entries;
    try {
      return await this.readDisk(mtime);
    } catch (err) {
      // A hand edit mid-save or with a typo must not take down every lookup
      // that was already answerable. With nothing cached there is no fallback.
      if (this.entries) return this.entries;
      throw err;
    }
  }

  /** Throws on unparseable JSON — a mint must never overwrite a file it cannot read. */
  private async readDisk(mtime: number | null): Promise<IdentityMapEntry[]> {
    const raw = await this.opts.storage.read(this.mapPath);
    const parsed: IdentityMapEntry[] = raw ? JSON.parse(raw) : [];
    this.entries = parsed;
    this.loadedMtime = mtime;
    return parsed;
  }

  private async mint(
    platform: string,
    platformUserId: string,
    displayLabel: string | undefined,
  ): Promise<string> {
    const entry: IdentityMapEntry = {
      platform,
      platformUserId,
      userId: randomUUID().replace(/-/g, '').slice(0, 12),
      displayLabel: displayLabel ?? `${platform}:${platformUserId}`,
      firstSeenAt: new Date().toISOString(),
    };
    await this.opts.storage.mkdir(join(this.opts.dataDir, 'users'));

    const release = await acquireIdentityMapLock(identityMapLockPath(this.mapPath));
    try {
      for (let attempt = 0; attempt < MAX_MINT_ATTEMPTS; attempt++) {
        const onDisk = await this.readDisk(await this.opts.storage.mtime(this.mapPath));
        const already = findEntry(onDisk, platform, platformUserId);
        if (already) return already.userId;

        await this.opts.storage.writeAtomic(
          this.mapPath,
          JSON.stringify([...onDisk, entry], null, 2),
        );

        const after = await this.readDisk(await this.opts.storage.mtime(this.mapPath));
        const landed = findEntry(after, platform, platformUserId);
        if (landed) return landed.userId;
      }
      throw new Error(
        `identity map: could not persist ${platform}:${platformUserId} to ${this.mapPath} — ` +
          `it was overwritten by a writer that does not take the lock ${MAX_MINT_ATTEMPTS} times`,
      );
    } finally {
      release();
    }
  }

  private async enqueueMint<T>(task: () => Promise<T>): Promise<T> {
    const previous = mintQueues.get(this.mapPath) ?? Promise.resolve();
    const run = previous.then(task, task);
    const settled = run.catch(() => {});
    mintQueues.set(this.mapPath, settled);
    try {
      return await run;
    } finally {
      if (mintQueues.get(this.mapPath) === settled) mintQueues.delete(this.mapPath);
    }
  }
}

function findEntry(
  entries: IdentityMapEntry[],
  platform: string,
  platformUserId: string,
): IdentityMapEntry | undefined {
  return entries.find((e) => e.platform === platform && e.platformUserId === platformUserId);
}

// ---------------------------------------------------------------------------
// The `identity-map.json.lock` sentinel
// ---------------------------------------------------------------------------

/**
 * How long a mint waits for another process's mint before it gives up.
 *
 * A hold is one re-read, one atomic write and one read-back of a small JSON
 * file — milliseconds — so this is several orders of magnitude of headroom, and
 * it is spent inside an inbound message that already waits seconds on a model.
 *
 * Exhausting it THROWS, and the sender's message fails with it; their next
 * message tries again. That is the fail-safe of the three outcomes available:
 * writing without the lock reopens the race this lock closes, and answering with
 * a userId that was never recorded hands out the very split `USER.md` the race
 * caused. The wait only runs out when a holder is alive and not finishing — a
 * hung filesystem, or a pid the OS recycled — and neither is fixed by waiting
 * longer, or by taking a live holder's lock away.
 */
const LOCK_WAIT_MS = 10_000;
const LOCK_RETRY_MS = 20;
/**
 * A lock body with no readable holder is a process that died between its `wx`
 * create and its write (or a foreign file). Fresh, it may be a live holder in
 * that microsecond gap, so it waits; past this age, no writer is still in it.
 */
const UNREADABLE_LOCK_STALE_MS = 5_000;

export function identityMapLockPath(mapPath: string): string {
  return `${mapPath}.lock`;
}

/**
 * Take the identity map's advisory exclusive lock; resolves to its `release`.
 *
 * The protocol, and the raw `node:fs` carve-out, is `acquireSentinelLock` in
 * `backup/sentinel-lock.ts`, shared with `acquireBackupLock` (read its comment
 * for the full reasoning): a `wx` create is the one atomic step; the creator
 * confirms its `token` survived; an incumbent is reclaimed only when provably
 * abandoned (another boot, or a pid nothing is wearing) and its bytes are
 * unchanged since read; `release` unlinks only our own bytes. A live holder from
 * this boot is NEVER stale at any age. What remains open, as for the backup
 * lock: POSIX has no compare-and-delete, so two contenders taking over the SAME
 * abandoned lock within microseconds can both believe they hold it.
 *
 * What is this lock's own: it WAITS (`LOCK_WAIT_MS` by default, polling every
 * `LOCK_RETRY_MS`) and then throws; a body with no readable holder is stale past
 * `UNREADABLE_LOCK_STALE_MS`; and the refusal says nothing was written.
 *
 * Sound only where it is meant to be. Holder identity is a pid and a boot, which
 * mean something only on the machine that wrote them: a data directory shared by
 * two machines over a network filesystem reads the other machine's live holder as
 * gone and takes it over. A filesystem without a reliable exclusive create
 * (NFSv2) does not provide the exclusive create at all.
 */
export async function acquireIdentityMapLock(
  lockPath: string,
  timeoutMs: number = LOCK_WAIT_MS,
): Promise<() => void> {
  return await acquireSentinelLock({
    lockPath,
    timeoutMs,
    retryMs: LOCK_RETRY_MS,
    unreadableStaleMs: UNREADABLE_LOCK_STALE_MS,
    refusal: (pid) =>
      `identity map: ${lockPath} is still held${pid === null ? '' : ` by process ${pid}`} ` +
      `after ${timeoutMs}ms, so this new sender was not recorded — nothing was written, and ` +
      'their next message tries again. ' +
      (pid === null
        ? 'If no Ethos process is running, delete that file.'
        : `Check with \`ps -p ${pid}\`: only once process ${pid} is confirmed gone, delete ` +
          `${lockPath}. Deleting it while that process is recording a user lets both write ` +
          'the map at once, and one of the two new users can be lost.'),
  });
}
