import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteSessionStore, SqliteApiKeyStore } from '@ethosagent/session-sqlite';
import { FsStorage } from '@ethosagent/storage-fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWebApi, WebTokenRepository } from '../../index';
import { SCOPE_MAP } from '../../middleware/dual-auth';
import {
  makeStubAgentLoop,
  makeStubMemoryBundle,
  makeStubPersonalityRegistry,
} from '../test-helpers';

// plan channel-prompts-ui §4: the six room-policy procedures are cookie-only
// (`platforms` is not a SCOPE_MAP namespace, so `dualAuth` refuses every bearer
// key) and their writes pass the CSRF middleware that guards every cookie
// `/rpc/*` request. Driven through `createWebApi` like the other rpc tests.

const SAME = { origin: 'http://localhost:3000', host: 'localhost:3000' };
const CROSS = { origin: 'http://localhost:5999', host: 'localhost:3000' };

const PROCEDURES: Array<[string, unknown]> = [
  ['listRoomPolicies', { platform: 'slack' }],
  [
    'setRoomPolicy',
    { platform: 'slack', selector: 'C0X', entry: { prompt: 'p' }, expectedVersion: null },
  ],
  ['deleteRoomPolicy', { platform: 'slack', selector: 'C0X', expectedVersion: 'abcd1234' }],
  ['previewRoomPolicy', { platform: 'slack', chatId: 'C0X', isDm: false }],
  ['listRecentRooms', { platform: 'slack' }],
  ['setRoomPlatformSettings', { platform: 'slack', fetchMetadata: true }],
];

describe('room-policy RPC auth', () => {
  let dataDir: string;
  let sessions: SQLiteSessionStore;
  let apiKeys: SqliteApiKeyStore;
  let app: ReturnType<typeof createWebApi>['app'];
  let cookie: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'ethos-room-rpc-'));
    sessions = new SQLiteSessionStore(':memory:');
    apiKeys = new SqliteApiKeyStore(':memory:');
    ({ app } = createWebApi({
      dataDir,
      sessionStore: sessions,
      memoryBundle: makeStubMemoryBundle(),
      agentLoop: makeStubAgentLoop(),
      personalities: makeStubPersonalityRegistry(),
      chatDefaults: { model: 'claude-test', provider: 'anthropic' },
      apiKeys,
    }));
    const token = await new WebTokenRepository({ dataDir, storage: new FsStorage() }).getOrCreate();
    const exchange = await app.request(`/auth/exchange?t=${token}`, { headers: SAME });
    cookie = (exchange.headers.get('set-cookie') ?? '').split(/;\s*/)[0] ?? '';
    expect(cookie).toBeTruthy();
  });

  afterEach(async () => {
    sessions.close();
    apiKeys.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const call = (method: string, input: unknown, headers: Record<string, string>) =>
    app.request(`/rpc/platforms/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ json: input }),
    });

  it('platforms is not a SCOPE_MAP namespace (the reason bearer keys are refused)', () => {
    expect(Object.keys(SCOPE_MAP)).not.toContain('platforms');
  });

  it.each(PROCEDURES)('a bearer key is refused with 403 on %s', async (method, input) => {
    for (const scopes of [['sessions:read'], ['personalities:read', 'sessions:read']]) {
      const { secret } = await apiKeys.create({ name: `k-${method}`, scopes });
      const res = await call(method, input, { authorization: `Bearer ${secret}`, ...SAME });
      expect(res.status).toBe(403);
    }
    // Nothing was written by any refused call.
    await expect(readFile(join(dataDir, 'channels', 'slack', 'C0X.md'), 'utf8')).rejects.toThrow();
  });

  it('a cookie request works end to end: set, list, preview, delete', async () => {
    const headers = { cookie, ...SAME };
    const set = await call(
      'setRoomPolicy',
      {
        platform: 'slack',
        selector: 'C0DEPLOY',
        entry: { prompt: 'Deploys only.', tier: 'trivial', mode: 'mention_only' },
        expectedVersion: null,
      },
      headers,
    );
    expect(set.status).toBe(200);
    const saved = ((await set.json()) as { json: { ok: boolean; entry: { version: string } } })
      .json;
    expect(saved.ok).toBe(true);
    expect(await readFile(join(dataDir, 'channels', 'slack', 'C0DEPLOY.md'), 'utf8')).toBe(
      'Deploys only.',
    );

    const list = await call('listRoomPolicies', { platform: 'slack' }, headers);
    const listed = ((await list.json()) as { json: { entries: Array<{ selector: string }> } }).json;
    expect(listed.entries.map((e) => e.selector)).toEqual(['C0DEPLOY']);

    const preview = await call(
      'previewRoomPolicy',
      { platform: 'slack', chatId: 'C0DEPLOY', isDm: false },
      headers,
    );
    expect(((await preview.json()) as { json: { block: string } }).json.block).toContain(
      'Deploys only.',
    );

    const stale = await call(
      'deleteRoomPolicy',
      { platform: 'slack', selector: 'C0DEPLOY', expectedVersion: 'deadbeef' },
      headers,
    );
    expect(stale.status).toBe(409);
    const del = await call(
      'deleteRoomPolicy',
      { platform: 'slack', selector: 'C0DEPLOY', expectedVersion: saved.entry.version },
      headers,
    );
    expect(((await del.json()) as { json: unknown }).json).toEqual({ ok: true, removed: true });
  });

  it('maps refusals to the plan status codes: 400 bad mode and traversal, 413 too long', async () => {
    const headers = { cookie, ...SAME };
    const set = (selector: string, entry: Record<string, unknown>) =>
      call('setRoomPolicy', { platform: 'slack', selector, entry, expectedVersion: null }, headers);
    expect((await set('C0X', { mode: 'regex_match' })).status).toBe(400);
    expect((await set('../x', { prompt: 'p' })).status).toBe(400);
    expect((await set('C0X', { prompt: 'a'.repeat(4001) })).status).toBe(413);
  });

  it.each(PROCEDURES)(
    'a cross-origin cookie POST to %s is refused and writes nothing',
    async (method, input) => {
      const res = await call(method, input, { cookie, ...CROSS });
      expect(res.status).toBe(401);
      expect(JSON.stringify(await res.json())).toMatch(/Cross-origin/);
      await expect(readFile(join(dataDir, 'config.yaml'), 'utf8')).rejects.toThrow();
      await expect(
        readFile(join(dataDir, 'channels', 'slack', 'C0X.md'), 'utf8'),
      ).rejects.toThrow();
    },
  );
});
