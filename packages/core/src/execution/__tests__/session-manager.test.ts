import type {
  ExecChunk,
  ExecSession,
  ExecutionBackend,
  PersonalityConfig,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { type SessionLifecycleEvent, SessionManager } from '../session-manager';

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

const makeDeferred = (): Deferred => {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

class FakeBackend implements ExecutionBackend {
  readonly name = 'fake';
  spawnSessionCalls = 0;
  disposeTimeline: string[] = [];
  holdNext: Deferred | null = null;
  sessions: Array<ExecSession & { id: number; execLog: string[] }> = [];
  private seq = 0;
  private firstSessionId: number | null = null;

  isAvailable(): Promise<boolean> {
    return Promise.resolve(true);
  }

  // biome-ignore lint/correctness/useYield: top-level exec is never used in these tests
  async *exec(): AsyncIterable<ExecChunk> {
    throw new Error('not used');
  }

  mountsFor(p: PersonalityConfig) {
    const reads = (p.fs_reach?.read ?? []).map((path) => ({
      hostPath: path,
      containerPath: path,
      mode: 'ro' as const,
    }));
    const writes = (p.fs_reach?.write ?? []).map((path) => ({
      hostPath: path,
      containerPath: path,
      mode: 'rw' as const,
    }));
    return [...reads, ...writes];
  }

  spawnSession(personalityId: string): ExecSession {
    this.spawnSessionCalls++;
    const id = ++this.seq;
    if (this.firstSessionId === null) this.firstSessionId = id;
    const backend = this;
    const execLog: string[] = [];
    const session = {
      id,
      personalityId,
      execLog,
      async *exec(cmd: string): AsyncIterable<ExecChunk> {
        execLog.push(cmd);
        if (backend.holdNext && id === backend.firstSessionId) {
          await backend.holdNext.promise;
          backend.disposeTimeline.push('held-exec-done');
        }
        yield { stream: 'stdout', data: `out:${cmd}` };
      },
      dispose: () => {
        backend.disposeTimeline.push(`dispose-${id}`);
        return Promise.resolve();
      },
    };
    this.sessions.push(session);
    return session;
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

const mkP = (id: string, fsReach?: PersonalityConfig['fs_reach']): PersonalityConfig =>
  ({ id, name: id, fs_reach: fsReach }) as unknown as PersonalityConfig;

const drain = async (it: AsyncIterable<ExecChunk>): Promise<ExecChunk[]> => {
  const out: ExecChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
};

describe('SessionManager', () => {
  it('persists session across turns within a lane', async () => {
    const fake = new FakeBackend();
    const mgr = new SessionManager(fake);
    const p = mkP('alice');
    await drain(mgr.exec('one', { personality: p, sessionId: 's1' }));
    await drain(mgr.exec('two', { personality: p, sessionId: 's1' }));
    expect(fake.spawnSessionCalls).toBe(1);
    const session = fake.sessions[0];
    expect(session?.execLog).toEqual(['one', 'two']);
  });

  it('lazy spawn — no session until first exec', async () => {
    const fake = new FakeBackend();
    const mgr = new SessionManager(fake);
    expect(fake.spawnSessionCalls).toBe(0);
    await drain(mgr.exec('go', { personality: mkP('alice'), sessionId: 's1' }));
    expect(fake.spawnSessionCalls).toBe(1);
  });

  it('hash-based recreate on fs_reach change', async () => {
    const fake = new FakeBackend();
    const events: SessionLifecycleEvent[] = [];
    const mgr = new SessionManager(fake, { onEvent: (e) => events.push(e) });
    await drain(
      mgr.exec('a', { personality: mkP('alice', { read: ['/a', '/b'] }), sessionId: 's1' }),
    );
    await drain(mgr.exec('b', { personality: mkP('alice', { read: ['/a'] }), sessionId: 's1' }));
    expect(fake.spawnSessionCalls).toBe(2);
    expect(fake.disposeTimeline).toContain('dispose-1');
    expect(events.some((e) => e.type === 'recreated' && e.reason === 'config-change')).toBe(true);
  });

  it('recreate triggers on in-place mutation (content-hash not identity)', async () => {
    const fake = new FakeBackend();
    const mgr = new SessionManager(fake);
    const p = mkP('alice', { read: ['/a'] });
    await drain(mgr.exec('a', { personality: p, sessionId: 's1' }));
    const reach = p.fs_reach;
    if (reach?.read) reach.read.push('/c');
    await drain(mgr.exec('b', { personality: p, sessionId: 's1' }));
    expect(fake.spawnSessionCalls).toBe(2);
  });

  it('idle eviction', async () => {
    const fake = new FakeBackend();
    const events: SessionLifecycleEvent[] = [];
    let clock = 0;
    const now = () => clock;
    const mgr = new SessionManager(fake, { onEvent: (e) => events.push(e), now, idleTtlMs: 1000 });
    const p = mkP('alice');
    await drain(mgr.exec('a', { personality: p, sessionId: 'a' }));
    clock = 2000;
    await drain(mgr.exec('b', { personality: p, sessionId: 'b' }));
    expect(fake.disposeTimeline).toContain('dispose-1');
    const evicted = events.find((e) => e.type === 'evicted' && e.reason === 'idle');
    expect(evicted).toBeDefined();
    expect(evicted?.personalityId).toBe('alice');
    expect(evicted?.sessionId).toBe('a');
  });

  it('global cap LRU eviction', async () => {
    const fake = new FakeBackend();
    const events: SessionLifecycleEvent[] = [];
    let clock = 0;
    const now = () => clock;
    const mgr = new SessionManager(fake, { onEvent: (e) => events.push(e), now, maxSessions: 2 });
    const p = mkP('alice');
    clock = 10;
    await drain(mgr.exec('a', { personality: p, sessionId: 'a' }));
    clock = 20;
    await drain(mgr.exec('b', { personality: p, sessionId: 'b' }));
    clock = 30;
    await drain(mgr.exec('c', { personality: p, sessionId: 'c' }));
    expect(fake.spawnSessionCalls).toBe(3);
    const capEvents = events.filter((e) => e.type === 'evicted' && e.reason === 'cap');
    expect(capEvents).toHaveLength(1);
    // session-1 (sessionId 'a') was the oldest
    expect(fake.disposeTimeline).toContain('dispose-1');
  });

  it('debounce coalesces concurrent recreates', async () => {
    const fake = new FakeBackend();
    const events: SessionLifecycleEvent[] = [];
    const mgr = new SessionManager(fake, { onEvent: (e) => events.push(e) });
    await drain(mgr.exec('init', { personality: mkP('alice', { read: ['/a'] }), sessionId: 's1' }));
    const changed = mkP('alice', { read: ['/b'] });
    await Promise.all(
      Array.from({ length: 5 }, () =>
        drain(mgr.exec('x', { personality: changed, sessionId: 's1' })),
      ),
    );
    const disposeOne = fake.disposeTimeline.filter((d) => d === 'dispose-1');
    expect(disposeOne).toHaveLength(1);
    const recreated = events.filter((e) => e.type === 'recreated');
    expect(recreated).toHaveLength(1);
  });

  it('mid-exec dispose drains (config-change waits for in-flight)', async () => {
    const fake = new FakeBackend();
    const deferred = makeDeferred();
    fake.holdNext = deferred;
    const mgr = new SessionManager(fake);
    const p = mkP('alice', { read: ['/a'] });

    // Start a held exec in the background; the held session is session-1.
    const bgExec = drain(mgr.exec('held', { personality: p, sessionId: 'x' }));
    await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 5));

    // Trigger a config-change recreate while the first exec is still in-flight.
    const changed = mkP('alice', { read: ['/b'] });
    const bgRecreate = drain(mgr.exec('after', { personality: changed, sessionId: 'x' }));
    await new Promise((r) => setTimeout(r, 5));

    // The old session must NOT have been disposed yet — recreate drains first.
    expect(fake.disposeTimeline).not.toContain('dispose-1');

    deferred.resolve();
    await Promise.all([bgExec, bgRecreate]);

    const heldIdx = fake.disposeTimeline.indexOf('held-exec-done');
    const disposeIdx = fake.disposeTimeline.indexOf('dispose-1');
    expect(heldIdx).toBeGreaterThanOrEqual(0);
    expect(disposeIdx).toBeGreaterThan(heldIdx);
  });

  it('events carry correct fields', async () => {
    const fake = new FakeBackend();
    const events: SessionLifecycleEvent[] = [];
    let clock = 0;
    const now = () => clock;
    const mgr = new SessionManager(fake, {
      onEvent: (e) => events.push(e),
      now,
      idleTtlMs: 1000,
      maxSessions: 8,
    });
    await drain(mgr.exec('a', { personality: mkP('alice', { read: ['/a'] }), sessionId: 's1' }));
    const spawned = events.find((e) => e.type === 'spawned');
    expect(spawned).toMatchObject({ personalityId: 'alice', sessionId: 's1' });

    await drain(mgr.exec('b', { personality: mkP('alice', { read: ['/x'] }), sessionId: 's1' }));
    const recreated = events.find((e) => e.type === 'recreated');
    expect(recreated).toMatchObject({
      personalityId: 'alice',
      sessionId: 's1',
      reason: 'config-change',
    });

    clock = 5000;
    await drain(mgr.exec('c', { personality: mkP('alice'), sessionId: 's2' }));
    const evicted = events.find((e) => e.type === 'evicted' && e.reason === 'idle');
    expect(evicted).toMatchObject({ personalityId: 'alice', sessionId: 's1', reason: 'idle' });
  });
});
