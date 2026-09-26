import { join } from 'node:path';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { LeaseRepository } from '../../repositories/lease.repository';

const DATA = '/data';
const FILE = join(DATA, 'approval-leases.json');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.parse('2026-09-24T10:00:00.000Z');

describe('LeaseRepository', () => {
  let storage: InMemoryStorage;
  let clock: number;
  let repo: LeaseRepository;

  const grantInput = {
    toolName: 'skills_pending_approve',
    sessionId: 'sess_1',
    personalityId: 'engineer',
    grantedBy: 'tab-A',
  };

  beforeEach(() => {
    storage = new InMemoryStorage();
    clock = T0;
    repo = new LeaseRepository({ dataDir: DATA, storage, now: () => clock });
  });

  it('grant → findActive hits for the same tool, session and personality', async () => {
    const lease = await repo.grant(grantInput, HOUR);
    expect(lease.expiresAt).toBe(new Date(T0 + HOUR).toISOString());
    expect(lease.revokedAt).toBeNull();
    const hit = await repo.findActive('skills_pending_approve', 'sess_1', 'engineer', T0 + 1);
    expect(hit?.id).toBe(lease.id);
  });

  it('misses for another session', async () => {
    await repo.grant(grantInput, HOUR);
    expect(await repo.findActive('skills_pending_approve', 'sess_2', 'engineer', T0)).toBeNull();
  });

  it('misses for another personality, and a bound lease misses a call with none', async () => {
    await repo.grant(grantInput, HOUR);
    expect(await repo.findActive('skills_pending_approve', 'sess_1', 'coach', T0)).toBeNull();
    expect(await repo.findActive('skills_pending_approve', 'sess_1', null, T0)).toBeNull();
  });

  it('a null-personality lease matches only a call without one', async () => {
    await repo.grant({ ...grantInput, personalityId: null }, HOUR);
    expect(await repo.findActive('skills_pending_approve', 'sess_1', null, T0)).not.toBeNull();
    expect(await repo.findActive('skills_pending_approve', 'sess_1', 'engineer', T0)).toBeNull();
  });

  it('misses for another tool', async () => {
    await repo.grant(grantInput, HOUR);
    expect(await repo.findActive('skills_pending_reject', 'sess_1', 'engineer', T0)).toBeNull();
  });

  it('misses after revoke', async () => {
    const lease = await repo.grant(grantInput, HOUR);
    const revoked = await repo.revoke(lease.id);
    expect(revoked?.revokedAt).toBe(new Date(T0).toISOString());
    expect(await repo.findActive('skills_pending_approve', 'sess_1', 'engineer', T0)).toBeNull();
  });

  it('revoke of an unknown id returns null', async () => {
    expect(await repo.revoke('nope')).toBeNull();
  });

  it('misses once the clock passes expiry (3_600_001 ms)', async () => {
    await repo.grant(grantInput, HOUR);
    expect(
      await repo.findActive('skills_pending_approve', 'sess_1', 'engineer', T0 + 3_600_001),
    ).toBeNull();
  });

  it('drops a tampered row with no expiresAt instead of treating it as open-ended', async () => {
    const good = await repo.grant(grantInput, HOUR);
    const file = JSON.parse((await storage.read(FILE)) ?? '{}') as { leases: unknown[] };
    const { expiresAt: _dropped, ...open } = { ...good, id: 'tampered', sessionId: 'sess_x' };
    file.leases.push(open);
    await storage.write(FILE, JSON.stringify(file));

    expect(await repo.findActive('skills_pending_approve', 'sess_x', 'engineer', T0)).toBeNull();
    expect((await repo.list()).map((l) => l.id)).toEqual([good.id]);
  });

  it('concurrent grants both persist', async () => {
    const [a, b] = await Promise.all([
      repo.grant(grantInput, HOUR),
      repo.grant({ ...grantInput, sessionId: 'sess_2' }, HOUR),
    ]);
    const ids = (await repo.list()).map((l) => l.id).sort();
    expect(ids).toEqual([a.id, b.id].sort());
  });

  it('a grant prunes rows expired or revoked more than seven days ago', async () => {
    const old = await repo.grant(grantInput, HOUR);
    const revokedOld = await repo.grant({ ...grantInput, sessionId: 'sess_r' }, 30 * DAY);
    await repo.revoke(revokedOld.id);
    const recent = await repo.grant({ ...grantInput, sessionId: 'sess_recent' }, HOUR);

    // Eight days later: `old` expired 8d-1h ago, `revokedOld` was revoked 8d
    // ago, `recent` expired 8d-1h ago too — all past the window.
    clock = T0 + 8 * DAY;
    const fresh = await repo.grant({ ...grantInput, sessionId: 'sess_new' }, HOUR);
    expect((await repo.list()).map((l) => l.id)).toEqual([fresh.id]);
    expect([old.id, revokedOld.id, recent.id]).not.toContain(fresh.id);
  });

  it('keeps rows that expired within the last seven days', async () => {
    const lease = await repo.grant(grantInput, HOUR);
    clock = T0 + 6 * DAY;
    await repo.grant({ ...grantInput, sessionId: 'sess_new' }, HOUR);
    expect((await repo.list()).map((l) => l.id)).toContain(lease.id);
  });
});
