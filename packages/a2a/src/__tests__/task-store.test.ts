// Task store — lifecycle bookkeeping + SSE pub/sub + idempotency index.

import { describe, expect, it } from 'vitest';
import { type A2aTask, InMemoryA2aTaskStore, isTerminalStatus, newTaskId } from '../task-store';

function seed(overrides: Partial<A2aTask> = {}): A2aTask {
  return {
    id: newTaskId(),
    status: 'submitted',
    createdAt: 1,
    idempotencyKey: 'k',
    traceId: 't',
    peerFingerprint: 'fp',
    ...overrides,
  };
}

describe('isTerminalStatus', () => {
  it('classifies all five terminal states and neither non-terminal state', () => {
    for (const s of ['completed', 'failed', 'cancelled', 'expired', 'peer-unreachable'] as const) {
      expect(isTerminalStatus(s)).toBe(true);
    }
    expect(isTerminalStatus('submitted')).toBe(false);
    expect(isTerminalStatus('working')).toBe(false);
  });
});

describe('InMemoryA2aTaskStore', () => {
  it('creates, gets, and updates a task', async () => {
    const store = new InMemoryA2aTaskStore();
    const task = seed();
    await store.create(task);
    expect((await store.get(task.id))?.status).toBe('submitted');
    const updated = await store.update(task.id, { status: 'working' });
    expect(updated?.status).toBe('working');
    expect((await store.get(task.id))?.status).toBe('working');
  });

  it('finds by (peerFingerprint, idempotencyKey) and scopes by peer', async () => {
    const store = new InMemoryA2aTaskStore();
    const a = seed({ peerFingerprint: 'fp-a', idempotencyKey: 'k' });
    await store.create(a);
    expect((await store.findByIdempotencyKey('fp-a', 'k'))?.id).toBe(a.id);
    expect(await store.findByIdempotencyKey('fp-b', 'k')).toBeNull();
    expect(await store.findByIdempotencyKey('fp-a', 'other')).toBeNull();
  });

  it('notifies subscribers on update until unsubscribed', async () => {
    const store = new InMemoryA2aTaskStore();
    const task = seed();
    await store.create(task);
    const seen: string[] = [];
    const unsub = store.subscribe(task.id, (t) => seen.push(t.status));
    await store.update(task.id, { status: 'working' });
    await store.update(task.id, { status: 'completed', result: 'x' });
    unsub();
    await store.update(task.id, { status: 'failed' });
    expect(seen).toEqual(['working', 'completed']);
  });
});
