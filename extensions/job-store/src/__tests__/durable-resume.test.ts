import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from '@ethosagent/sqlite';
import type { BackgroundJob, CreateBackgroundJobInput } from '@ethosagent/types';
import { afterEach, describe, expect, it } from 'vitest';
import { SQLiteJobStore } from '../index';

// Pins the durable-background-jobs store surface: resume columns, crash and
// restart requeue, manual requeue, queued TTL from the last requeue, taint.

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

function baseInput(overrides: Partial<CreateBackgroundJobInput> = {}): CreateBackgroundJobInput {
  return {
    owner: 'owner-A',
    parentSessionKey: 'cli:root',
    rootSessionKey: 'cli:root',
    childSessionKey: 'cli:root:job:build:abcd1234',
    depth: 1,
    prompt: 'do the thing',
    ...overrides,
  };
}

function tmpPath(): string {
  const path = join(tmpdir(), `jobstore-resume-${randomUUID()}.db`);
  tmpFiles.push(path);
  return path;
}

interface Fixture {
  store: SQLiteJobStore;
  raw: InstanceType<typeof Database>;
  path: string;
}

function open(): Fixture {
  const path = tmpPath();
  const store = new SQLiteJobStore(path);
  return { store, raw: new Database(path), path };
}

/** A running row stamped resumable, with a heartbeat old enough to be swept. */
async function agedStamped(f: Fixture): Promise<BackgroundJob> {
  const created = await f.store.create(baseInput());
  const claimed = await f.store.claimNextQueued('owner-A');
  expect(claimed?.id).toBe(created.id);
  await f.store.setResumeAffinity(created.id, AFFINITY);
  f.raw.prepare('UPDATE jobs SET heartbeat_at = 1 WHERE id = ?').run(created.id);
  return created;
}

async function lastEvent(f: Fixture, id: string) {
  const events = await f.store.getEvents(id);
  return events[events.length - 1];
}

function close(f: Fixture): void {
  f.raw.close();
  f.store.close();
}

describe('reclaimStale — crash requeue (D13)', () => {
  it('requeues a stamped stale-aged row under the released label', async () => {
    const f = open();
    const job = await agedStamped(f);
    const swept = await f.store.reclaimStale(90_000, { maxResumes: 3 });
    const row = await f.store.get(job.id);
    expect(row?.status).toBe('queued');
    expect(row?.owner).toBe(`released:${AFFINITY}`);
    expect(row?.resumeCount).toBe(1);
    expect(row?.requeuedAt).toBeTypeOf('number');
    expect(row?.heartbeatAt).toBeUndefined();
    expect(row?.error).toBeUndefined();
    expect((await lastEvent(f, job.id))?.eventType).toBe('requeued');
    expect((await lastEvent(f, job.id))?.payload).toEqual({
      reason: 'crash',
      attempt: 1,
      interruptedTools: [],
    });
    expect(swept.map((j) => j.id)).toContain(job.id);
    close(f);
  });

  it('leaves a pending steer pending (no terminal sweep)', async () => {
    const f = open();
    const job = await agedStamped(f);
    await f.store.addSteer(job.id, { text: 'go left', source: 'web' });
    await f.store.reclaimStale(90_000, { maxResumes: 3 });
    expect((await f.store.listSteers(job.id)).map((s) => s.state)).toEqual(['pending']);
    close(f);
  });

  it('goes stale with the cap text once resume_count reaches maxResumes', async () => {
    const f = open();
    const job = await agedStamped(f);
    f.raw.prepare('UPDATE jobs SET resume_count = 3 WHERE id = ?').run(job.id);
    await f.store.reclaimStale(90_000, { maxResumes: 3 });
    const row = await f.store.get(job.id);
    expect(row?.status).toBe('stale');
    expect(row?.error).toBe('stalled — no heartbeat (auto-resume limit 3 reached)');
    close(f);
  });

  it("an unstamped row keeps today's stale text", async () => {
    const f = open();
    const job = await agedStamped(f);
    await f.store.setResumeAffinity(job.id, null);
    await f.store.reclaimStale(90_000, { maxResumes: 3 });
    const row = await f.store.get(job.id);
    expect(row?.status).toBe('stale');
    expect(row?.error).toBe('stalled — no heartbeat');
    close(f);
  });

  it('without opts a stamped row goes stale (maxResumes defaults to 0)', async () => {
    const f = open();
    const job = await agedStamped(f);
    await f.store.reclaimStale(90_000);
    const row = await f.store.get(job.id);
    expect(row?.status).toBe('stale');
    expect(row?.error).toBe('stalled — no heartbeat');
    close(f);
  });
});

describe('requeueForResume — graceful restart', () => {
  it('requeues a running stamped row with a restart event', async () => {
    const f = open();
    const job = await agedStamped(f);
    expect(await f.store.requeueForResume(job.id, { reason: 'restart', maxResumes: 3 })).toBe(true);
    const row = await f.store.get(job.id);
    expect(row?.status).toBe('queued');
    expect(row?.owner).toBe(`released:${AFFINITY}`);
    expect((await lastEvent(f, job.id))?.payload).toEqual({
      reason: 'restart',
      attempt: 1,
      interruptedTools: [],
    });
    close(f);
  });

  it('accepts a blocked row and clears the parked-question fields', async () => {
    const f = open();
    const job = await agedStamped(f);
    await f.store.markBlocked(job.id, 'req-1');
    expect(await f.store.requeueForResume(job.id, { reason: 'restart', maxResumes: 3 })).toBe(true);
    const row = await f.store.get(job.id);
    expect(row?.status).toBe('queued');
    expect(row?.blockedSince).toBeUndefined();
    expect(row?.blockedRequestId).toBeUndefined();
    close(f);
  });

  it('refuses an unstamped row and leaves it unchanged', async () => {
    const f = open();
    await f.store.create(baseInput());
    const claimed = await f.store.claimNextQueued('owner-A');
    const id = claimed?.id ?? '';
    expect(await f.store.requeueForResume(id, { reason: 'restart', maxResumes: 3 })).toBe(false);
    expect((await f.store.get(id))?.status).toBe('running');
    close(f);
  });

  it('refuses at the cap', async () => {
    const f = open();
    const job = await agedStamped(f);
    f.raw.prepare('UPDATE jobs SET resume_count = 3 WHERE id = ?').run(job.id);
    expect(await f.store.requeueForResume(job.id, { reason: 'restart', maxResumes: 3 })).toBe(
      false,
    );
    expect((await f.store.get(job.id))?.status).toBe('running');
    close(f);
  });
});

describe('setResumeAffinity / noResume', () => {
  it('is a no-op on a no_resume row except for null', async () => {
    const f = open();
    await f.store.create(baseInput({ noResume: true }));
    const claimed = await f.store.claimNextQueued('owner-A');
    const id = claimed?.id ?? '';
    await f.store.setResumeAffinity(id, AFFINITY);
    expect((await f.store.get(id))?.resumeAffinity).toBeUndefined();
    f.raw.prepare('UPDATE jobs SET resume_affinity = ? WHERE id = ?').run(AFFINITY, id);
    await f.store.setResumeAffinity(id, null);
    expect((await f.store.get(id))?.resumeAffinity).toBeUndefined();
    close(f);
  });

  it('round-trips noResume and defaults resumeCount to 0', async () => {
    const f = open();
    const flagged = await f.store.create(baseInput({ noResume: true }));
    expect(flagged.noResume).toBe(true);
    const plain = await f.store.create(baseInput());
    expect(plain.noResume).toBeUndefined();
    expect(plain.resumeCount ?? 0).toBe(0);
    close(f);
  });
});

describe('expireQueued — TTL measured from the last requeue', () => {
  async function queuedRow(f: Fixture, createdAgoMs: number, requeuedAgoMs: number | null) {
    const job = await f.store.create(baseInput());
    const now = Date.now();
    f.raw
      .prepare('UPDATE jobs SET created_at = ?, requeued_at = ? WHERE id = ?')
      .run(now - createdAgoMs, requeuedAgoMs === null ? null : now - requeuedAgoMs, job.id);
    return job.id;
  }

  it("a recently requeued row survives; a long-requeued one expires; a fresh one keeps today's TTL", async () => {
    const f = open();
    const HOUR = 3_600_000;
    const recent = await queuedRow(f, 2 * HOUR, 60_000);
    const old = await queuedRow(f, 30 * HOUR, 25 * HOUR);
    const fresh = await queuedRow(f, 16 * 60_000, null);
    const expired = await f.store.expireQueued(900_000, { resumeTtlMs: 24 * HOUR });
    const ids = expired.map((j) => j.id);
    expect(ids).not.toContain(recent);
    expect(ids).toContain(old);
    expect(ids).toContain(fresh);
    expect((await f.store.get(recent))?.status).toBe('queued');
    close(f);
  });
});

describe('requeueStale — manual resume', () => {
  it('moves a stale row back to queued without counting it', async () => {
    const f = open();
    const job = await agedStamped(f);
    await f.store.reclaimStale(90_000);
    expect((await f.store.get(job.id))?.status).toBe('stale');
    expect(await f.store.requeueStale(job.id, 'released:web:host:boot')).toBe(true);
    const row = await f.store.get(job.id);
    expect(row?.status).toBe('queued');
    expect(row?.owner).toBe('released:web:host:boot');
    expect(row?.resumeCount ?? 0).toBe(0);
    expect(row?.error).toBeUndefined();
    expect(row?.finishedAt).toBeUndefined();
    expect((await lastEvent(f, job.id))?.payload).toEqual({
      reason: 'manual',
      attempt: 0,
      interruptedTools: [],
    });
    close(f);
  });

  it('refuses a row that is not stale', async () => {
    const f = open();
    const job = await agedStamped(f);
    await f.store.finish(job.id, 'done', { summary: 'ok' });
    expect(await f.store.requeueStale(job.id, 'released:web:host:boot')).toBe(false);
    expect((await f.store.get(job.id))?.status).toBe('done');
    close(f);
  });
});

describe('requeued event — interruptedTools', () => {
  const tool = (f: Fixture, id: string, type: 'tool_headline' | 'tool_end', toolName: string) =>
    f.store.appendEvent(id, type, { toolName });

  it('lists a started tool with no tool_end, ignores a finished one and everything before the previous claim', async () => {
    const f = open();
    const job = await agedStamped(f);
    // Before the previous claim: an unfinished tool that must be ignored.
    await tool(f, job.id, 'tool_headline', 'ancient');
    await f.store.requeueForResume(job.id, { reason: 'restart', maxResumes: 3 });
    await f.store.claimNextQueued(`released:${AFFINITY}`, { adopt: AFFINITY });
    await tool(f, job.id, 'tool_headline', 'terminal');
    await tool(f, job.id, 'tool_headline', 'read_file');
    await tool(f, job.id, 'tool_end', 'read_file');
    await tool(f, job.id, 'tool_headline', 'terminal');
    await tool(f, job.id, 'tool_end', 'terminal');
    await f.store.requeueForResume(job.id, { reason: 'restart', maxResumes: 3 });
    expect((await lastEvent(f, job.id))?.payload.interruptedTools).toEqual(['terminal']);
    close(f);
  });

  it('records them on a crash sweep and a manual requeue', async () => {
    const f = open();
    const job = await agedStamped(f);
    await tool(f, job.id, 'tool_headline', 'write_file');
    await f.store.reclaimStale(90_000, { maxResumes: 3 });
    expect((await lastEvent(f, job.id))?.payload.interruptedTools).toEqual(['write_file']);

    const stale = await f.store.create(baseInput());
    await f.store.claimNextQueued('owner-A');
    await tool(f, stale.id, 'tool_headline', 'terminal');
    f.raw.prepare("UPDATE jobs SET status = 'stale' WHERE id = ?").run(stale.id);
    await f.store.requeueStale(stale.id, 'owner-A');
    expect((await lastEvent(f, stale.id))?.payload.interruptedTools).toEqual(['terminal']);
    close(f);
  });

  it('getEvents filters by eventType', async () => {
    const f = open();
    const job = await agedStamped(f);
    await f.store.requeueForResume(job.id, { reason: 'restart', maxResumes: 3 });
    const only = await f.store.getEvents(job.id, { eventType: 'requeued', limit: 1 });
    expect(only.map((e) => e.eventType)).toEqual(['requeued']);
    close(f);
  });
});

describe('markTainted', () => {
  it('sets tainted and is idempotent', async () => {
    const f = open();
    const job = await f.store.create(baseInput());
    expect((await f.store.get(job.id))?.tainted).toBeUndefined();
    await f.store.markTainted(job.id);
    await f.store.markTainted(job.id);
    expect((await f.store.get(job.id))?.tainted).toBe(true);
    close(f);
  });
});

describe('schema', () => {
  const COLUMNS = ['resume_affinity', 'no_resume', 'resume_count', 'requeued_at'];
  const columnsOf = (db: InstanceType<typeof Database>) =>
    (db.pragma('table_info(jobs)') as Array<{ name: string }>).map((c) => c.name);
  const versionOf = (db: InstanceType<typeof Database>) =>
    (db.pragma('user_version') as Array<{ user_version: number }>)[0]?.user_version;

  it('user_version stays 10 after open', () => {
    const f = open();
    expect(versionOf(f.raw)).toBe(10);
    close(f);
  });

  it('a database without the four columns gains them on open, idempotently', async () => {
    const f = open();
    close(f);
    const raw = new Database(f.path);
    for (const c of COLUMNS) raw.exec(`ALTER TABLE jobs DROP COLUMN ${c}`);
    raw
      .prepare(
        `INSERT INTO jobs (id, owner, parent_session_key, root_session_key, child_session_key,
           depth, status, prompt, spend_usd, cancel_requested, created_at)
         VALUES ('legacy-1','owner-A','root','root','root:child',1,'queued','old job',0,0,1000)`,
      )
      .run();
    for (const c of COLUMNS) expect(columnsOf(raw)).not.toContain(c);
    raw.close();

    for (let i = 0; i < 2; i++) {
      const store = new SQLiteJobStore(f.path);
      const legacy = await store.get('legacy-1');
      expect(legacy?.resumeCount ?? 0).toBe(0);
      expect(legacy?.resumeAffinity).toBeUndefined();
      store.close();
    }
    const after = new Database(f.path);
    for (const c of COLUMNS) expect(columnsOf(after).filter((n) => n === c)).toHaveLength(1);
    expect(versionOf(after)).toBe(10);
    after.close();
  });
});
