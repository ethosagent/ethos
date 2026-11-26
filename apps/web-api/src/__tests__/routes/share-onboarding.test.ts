import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { FsStorage } from '@ethosagent/storage-fs';
import { SqliteShareLinkStore } from '@ethosagent/wiring';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NOT_FOUND_PAGE } from '../../features/share/render';
import { createWebApi } from '../../index';
import { makeStubMemoryBundle, makeStubPersonalityRegistry } from '../test-helpers';

// plan share-links §3 (processes without a share store): `ethos serve` in onboarding mode (no
// config.yaml, no agentLoop) and the desktop main process keep one createWebApi for the whole
// process, so they must hand it `shareLinks`. Without a host `/share/*` is not mounted and a
// share URL falls through to the SPA fallback (200 index.html) instead of the uniform 404, and
// deleting a session revokes nothing. Wiring pinned in apps/ethos/src/commands/serve.ts and
// apps/desktop/src/main/serve.ts; this file pins the web-api half.

const TOKEN = 'A'.repeat(43);

describe('createWebApi in onboarding mode (no agentLoop) with a share host', () => {
  let dir: string;
  let dist: string;
  let sessions: SQLiteSessionStore;
  let shares: SqliteShareLinkStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ethos-share-onboarding-'));
    dist = join(dir, 'web-dist');
    await mkdir(dist, { recursive: true });
    await writeFile(join(dist, 'index.html'), '<!doctype html><title>SPA</title>', 'utf-8');
    sessions = new SQLiteSessionStore(':memory:');
    shares = new SqliteShareLinkStore(':memory:');
  });
  afterEach(async () => {
    sessions.close();
    shares.close();
    await rm(dir, { recursive: true, force: true });
  });

  const build = (withShares: boolean) =>
    createWebApi({
      dataDir: dir,
      storage: new FsStorage(),
      sessionStore: sessions,
      memoryBundle: makeStubMemoryBundle(),
      personalities: makeStubPersonalityRegistry(),
      chatDefaults: { model: 'setup-required', provider: 'setup-required' },
      webDist: dist,
      ...(withShares
        ? { shareLinks: { store: shares, bind: { host: '127.0.0.1', port: 3000 } } }
        : {}),
    }).app;

  it('a well-formed unknown /share/<token> is the uniform 404, not the SPA', async () => {
    const res = await build(true).request(`/share/${TOKEN}`);
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toBe(NOT_FOUND_PAGE.html);
    expect(body).not.toContain('SPA');
  });

  it('control: with no share host the same URL falls through to the SPA (why serve must pass one)', async () => {
    const res = await build(false).request(`/share/${TOKEN}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('SPA');
  });
});
