import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from '@ethosagent/sqlite';
import type { CreateBackgroundJobInput } from '@ethosagent/types';
import { afterEach, describe, expect, it } from 'vitest';
import { SQLiteJobStore } from '../index';

// Fenced terminal writes, cancel-aware requeue, and a sweep that survives a
// malformed trail row (durable-background-jobs review fixes).

const AFFINITY = 'web:host:serve';
const tmpFiles: string[] = [];

afterEach(() => {
  for (const f of tmpFiles) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(f + suffix)) rmSync(f + suffix);
    }
  }
  tmpFiles.length = 0;
});

const input = (): CreateBackgroundJobInput => ({
  owner: 'owner-A',
  parentSessionKey: 'cli:root',
  rootSessionKey: 'cli:root',
  childSessionKey: 'cli:root:job:build:abcd1234',
  depth: 1,
  prompt: 'do the thing',
});

async function runningStamped() {
  const path = join(tmpdir(), `jobstore-fence-${randomUUID()}.db`);
  tmpFiles.push(path);
  const store = new SQLiteJobStore(path);
  const raw = new Database(path);
  const created = await store.create(input());
  const claimed = await store.claimNextQueued('owner-A');
  if (!claimed?.startedAt) throw new Error('claim failed');
  await store.setResumeAffinity(created.id, AFFINITY);
  return { store, raw, id: created.id, fence: { owner: 'owner-A', startedAt: claimed.startedAt } };
}

describe('fenced finish / updateSpend', () => {
  it('a finish by the wrong owner or startedAt leaves the row untouched', async () => {
    const { store, id, fence } = await runningStamped();
    await expect(
      store.finish(id, 'done', { summary: 'old' }, { ...fence, owner: 'owner-B' }),
    ).rejects.toThrow(/no longer held/);
    await expect(
      store.finish(id, 'done', { summary: 'old' }, { ...fence, startedAt: fence.startedAt - 1 }),
    ).rejects.toThrow(/no longer held/);
    const row = await store.get(id);
    expect(row?.status).toBe('running');
    expect(row?.summary).toBeUndefined();
    await store.finish(id, 'done', { summary: 'ok' }, fence);
    expect((await store.get(id))?.status).toBe('done');
    store.close();
  });

  it('a stale row keeps its claim, so the owner fence still finishes it (recovered path)', async () => {
    const { store, id, fence } = await runningStamped();
    await store.reclaimStale(-1);
    expect((await store.get(id))?.status).toBe('stale');
    await store.finish(id, 'done', {}, fence);
    expect((await store.get(id))?.status).toBe('done');
    store.close();
  });

  it('a fenced updateSpend by a stale claim does not write', async () => {
    const { store, id, fence } = await runningStamped();
    await store.updateSpend(id, 1.5, { ...fence, owner: 'owner-B' });
    expect((await store.get(id))?.spendUsd).toBe(0);
    await store.updateSpend(id, 2, fence);
    expect((await store.get(id))?.spendUsd).toBe(2);
    store.close();
  });
});

describe('requeue and cancel_requested', () => {
  it('a cancelled row is not requeued: graceful is ineligible, the crash sweep goes stale', async () => {
    const { store, raw, id } = await runningStamped();
    await store.requestCancel(id);
    expect(await store.requeueForResume(id, { reason: 'restart', maxResumes: 3 })).toBe(false);
    expect((await store.get(id))?.status).toBe('running');
    await store.reclaimStale(-1, { maxResumes: 3 });
    const row = await store.get(id);
    expect(row?.status).toBe('stale');
    // Ineligible, not capped: the error does not blame the resume limit.
    expect(row?.error).toBe('stalled — no heartbeat');
    raw.close();
    store.close();
  });
});

describe('reclaimStale with a malformed trail', () => {
  it('skips an unparseable or null tool_headline payload instead of rolling back the sweep', async () => {
    const { store, raw, id } = await runningStamped();
    await store.appendEvent(id, 'tool_headline', { toolName: 'terminal' });
    const ins = raw.prepare(
      `INSERT INTO job_events (job_id, seq, event_type, payload, created_at)
       VALUES (?, ?, 'tool_headline', ?, ?)`,
    );
    ins.run(id, 900, '{not json', Date.now());
    ins.run(id, 901, 'null', Date.now());
    const swept = await store.reclaimStale(-1, { maxResumes: 3 });
    expect(swept.map((j) => j.status)).toEqual(['queued']);
    const events = await store.getEvents(id, { eventType: 'requeued' });
    expect(events[0]?.payload.interruptedTools).toEqual(['terminal']);
    raw.close();
    store.close();
  });
});

describe('fenced markBlocked / resumeFromBlocked', () => {
  it('a park or unpark by another claim leaves the row untouched', async () => {
    const { store, id, fence } = await runningStamped();
    const other = { ...fence, owner: 'owner-B' };
    await store.markBlocked(id, 'q-1', other);
    expect((await store.get(id))?.status).toBe('running');
    await store.markBlocked(id, 'q-1', fence);
    expect((await store.get(id))?.status).toBe('blocked');
    await store.resumeFromBlocked(id, { ...fence, startedAt: fence.startedAt - 1 });
    expect((await store.get(id))?.status).toBe('blocked');
    await store.resumeFromBlocked(id, fence);
    expect((await store.get(id))?.status).toBe('running');
    store.close();
  });
});
