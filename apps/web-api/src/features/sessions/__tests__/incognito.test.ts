import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { incognitoSessionMetadata } from '@ethosagent/wiring';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionsRepository } from '../repository';
import { SessionsService } from '../service';

// Plan incognito-sessions D11, web part: the wire marks incognito sessions
// (`incognito`, never `metadata`), the plain list keeps them, FTS `q` skips them.

const base = {
  platform: 'web',
  model: 'm',
  provider: 'p',
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    estimatedCostUsd: 0,
    apiCallCount: 0,
    compactionCount: 0,
  },
};

describe('sessions incognito', () => {
  let store: SQLiteSessionStore;
  let service: SessionsService;

  beforeEach(() => {
    store = new SQLiteSessionStore(':memory:');
    service = new SessionsService({ sessions: new SessionsRepository(store) });
  });

  afterEach(() => store.close());

  async function seed() {
    const normal = await store.createSession({ ...base, key: 'web:n' });
    const hidden = await store.createSession({
      ...base,
      key: 'web:i',
      metadata: incognitoSessionMetadata(),
    });
    await store.appendMessage({ sessionId: normal.id, role: 'user', content: 'pineapple pizza' });
    await store.appendMessage({ sessionId: hidden.id, role: 'user', content: 'pineapple secret' });
    return { normal, hidden };
  }

  it('maps incognito on the wire and never exposes metadata', async () => {
    const { normal, hidden } = await seed();
    const { items } = await service.list({});
    const byId = new Map(items.map((s) => [s.id, s]));
    expect(byId.get(hidden.id)?.incognito).toBe(true);
    expect(byId.get(normal.id)?.incognito).toBeUndefined();
    for (const s of items) expect('metadata' in s).toBe(false);
    const got = await service.get(hidden.id);
    expect(got.session.incognito).toBe(true);
  });

  it('keeps incognito sessions in the plain list', async () => {
    const { hidden } = await seed();
    const { items } = await service.list({});
    expect(items.map((s) => s.id)).toContain(hidden.id);
  });

  it('skips incognito sessions in a q search', async () => {
    const { normal, hidden } = await seed();
    const { items } = await service.list({ q: 'pineapple' });
    const ids = items.map((s) => s.id);
    expect(ids).toContain(normal.id);
    expect(ids).not.toContain(hidden.id);
  });
});
