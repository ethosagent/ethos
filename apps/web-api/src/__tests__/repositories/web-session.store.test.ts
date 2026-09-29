import { InMemoryStorage } from '@ethosagent/storage-fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { WebSessionStore } from '../../repositories/web-session.store';

// web-auth-bootstrap D4 — server-side sessions minted by setup/login/reset.

const DIR = '/data';

describe('WebSessionStore', () => {
  let storage: InMemoryStorage;
  let store: WebSessionStore;

  beforeEach(() => {
    storage = new InMemoryStorage();
    store = new WebSessionStore({ dataDir: DIR, storage });
  });

  it('create mints a 64-char hex id that has() then accepts', async () => {
    const id = await store.create();
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(await store.has(id)).toBe(true);
    expect(await store.has('not-a-session')).toBe(false);
    expect(await store.has('')).toBe(false);
  });

  it('sessions survive a restart (persisted through Storage)', async () => {
    const id = await store.create();
    const reopened = new WebSessionStore({ dataDir: DIR, storage });
    expect(await reopened.has(id)).toBe(true);
  });

  it('an expired session is treated as absent', async () => {
    const shortLived = new WebSessionStore({ dataDir: DIR, storage, ttlMs: 1 });
    const id = await shortLived.create();
    await new Promise((r) => setTimeout(r, 5));
    expect(await shortLived.has(id)).toBe(false);
  });

  it('expired sessions are pruned on load', async () => {
    const shortLived = new WebSessionStore({ dataDir: DIR, storage, ttlMs: 1 });
    await shortLived.create();
    await new Promise((r) => setTimeout(r, 5));
    // A fresh instance loads, prunes, and a subsequent write persists the
    // pruned view.
    const reopened = new WebSessionStore({ dataDir: DIR, storage, ttlMs: 1 });
    await reopened.invalidateAll();
    const raw = (await storage.read(`${DIR}/web-sessions.json`)) as string;
    expect(JSON.parse(raw)).toEqual({ sessions: {} });
  });

  it('invalidateAll drops every session (D6: reset logs everyone out)', async () => {
    const a = await store.create();
    const b = await store.create();
    await store.invalidateAll();
    expect(await store.has(a)).toBe(false);
    expect(await store.has(b)).toBe(false);
  });
});
