import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsStorage } from '@ethosagent/storage-fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CallsService } from '../../services/calls.service';
import { DeliveriesService } from '../../services/deliveries.service';
import { ObservedChatsService } from '../../services/observed-chats.service';

// F06 follow-up — each of these opens its SQLite file lazily and caches the
// handle for the life of the process. `close()` is what the web API's dispose
// calls so no -wal/-shm is left behind; it is a no-op when nothing was opened.

describe('read-side stores close what they opened (F06)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ethos-readside-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('DeliveriesService.close closes an opened ledger, and is a no-op otherwise', async () => {
    const close = vi.fn();
    const service = new DeliveriesService({
      dataDir: dir,
      storage: new FsStorage(),
      openLedger: () => ({ close, listRecent: async () => [], counts: async () => ({}) }) as never,
    } as never);
    service.close();
    expect(close).not.toHaveBeenCalled();

    await new FsStorage().write(join(dir, 'delivery-ledger.db'), 'x');
    await service.summary().catch(() => {});
    service.close();
    expect(close).toHaveBeenCalledTimes(1);
    // Idempotent: the handle is forgotten, so a second close closes nothing.
    service.close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('CallsService.close and ObservedChatsService.close behave the same way', async () => {
    const closeLog = vi.fn();
    const closeStore = vi.fn();
    const storage = new FsStorage();
    await storage.write(join(dir, 'calls.db'), 'x');
    await storage.write(join(dir, 'channel-transcript.db'), 'x');
    const calls = new CallsService({
      dataDir: dir,
      storage,
      openLog: () => ({ close: closeLog, list: async () => [], active: async () => [] }) as never,
    } as never);
    const observed = new ObservedChatsService({
      dataDir: dir,
      storage,
      openStore: () =>
        ({
          close: closeStore,
          listLanes: async () => [],
          readSince: async () => ({ messages: [], omittedCount: 0 }),
        }) as never,
    } as never);

    await calls.list({}).catch(() => {});
    await observed.observed({}).catch(() => {});
    calls.close();
    observed.close();
    expect(closeLog).toHaveBeenCalledTimes(1);
    expect(closeStore).toHaveBeenCalledTimes(1);
  });
});
