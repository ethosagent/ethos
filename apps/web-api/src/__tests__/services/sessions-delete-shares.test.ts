import { hashShareToken, SqliteShareLinkStore } from '@ethosagent/wiring';
import { describe, expect, it } from 'vitest';
import type { SessionsRepository } from '../../features/sessions/repository';
import { SessionsService } from '../../features/sessions/service';

// plan share-links D4 (Lane D): deleting a session revokes its live share links, in the
// same call, recorded as the signed-in admin. Pinned here; the CLI half is
// apps/ethos/src/__tests__ (Lane G).

function link(store: SqliteShareLinkStore, sessionId: string) {
  return store.create({
    sessionId,
    personalityId: 'researcher',
    title: 'T',
    options: '{}',
    snapshot: '{"v":1}',
    expiresAt: new Date(Date.now() + 3_600_000),
    actor: 'web:alice',
  });
}

function setup(opts: { known?: boolean } = {}) {
  const store = new SqliteShareLinkStore(':memory:');
  const order: string[] = [];
  const repo = {
    get: async () => (opts.known === false ? null : { id: 'sess_1' }),
    delete: async () => {
      order.push('repo.delete');
    },
  } as unknown as SessionsRepository;
  const original = store.revokeForSession.bind(store);
  store.revokeForSession = (id, actor) => {
    order.push('revokeForSession');
    return original(id, actor);
  };
  const service = new SessionsService({
    sessions: repo,
    shareLinks: store,
    actor: async () => 'web:alice',
  });
  return { store, service, order };
}

describe('SessionsService.delete and share links', () => {
  it('revokes the deleted session’s live links as the admin, and only those', async () => {
    const { store, service } = setup();
    const mine = link(store, 'sess_1');
    const other = link(store, 'sess_2');

    await service.delete('sess_1');

    const rows = store.list({ activeOnly: false });
    expect(rows.find((r) => r.id === mine.record.id)?.revokedAt).not.toBeNull();
    expect(rows.find((r) => r.id === other.record.id)?.revokedAt).toBeNull();
    const events = store.listEvents(mine.record.id);
    expect(events.map((e) => [e.kind, e.actor])).toEqual([
      ['created', 'web:alice'],
      ['revoked', 'web:alice'],
    ]);
  });

  it('nulls the snapshot, so the URL stops serving', async () => {
    const { store, service } = setup();
    const { token, record } = link(store, 'sess_1');
    await service.delete('sess_1');
    expect(record.snapshot).not.toBeNull();
    expect(store.findLive(hashShareToken(token), new Date())).toBeNull();
  });

  it('revokes before the session row goes, so a failed delete never leaves a live link', async () => {
    const { service, order } = setup();
    await service.delete('sess_1');
    expect(order).toEqual(['revokeForSession', 'repo.delete']);
  });

  it('fails closed: a revoke failure surfaces and leaves the session intact', async () => {
    const { store, service, order } = setup();
    link(store, 'sess_1');
    store.revokeForSession = () => {
      order.push('revokeForSession');
      throw new Error('disk I/O error');
    };
    await expect(service.delete('sess_1')).rejects.toThrow('disk I/O error');
    expect(order).toEqual(['revokeForSession']);
  });

  it('an unknown session revokes nothing', async () => {
    const { store, service, order } = setup({ known: false });
    link(store, 'sess_1');
    await expect(service.delete('sess_1')).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
    expect(order).toEqual([]);
    expect(store.list({ activeOnly: true })).toHaveLength(1);
  });

  it('still deletes where no share store is wired (onboarding, tests)', async () => {
    const repo = {
      get: async () => ({ id: 'sess_1' }),
      delete: async () => {},
    } as unknown as SessionsRepository;
    await expect(new SessionsService({ sessions: repo }).delete('sess_1')).resolves.toBeUndefined();
  });
});
