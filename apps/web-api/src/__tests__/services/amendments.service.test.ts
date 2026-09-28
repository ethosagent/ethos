import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteSessionStore, SqliteApiKeyStore } from '@ethosagent/session-sqlite';
import { FsStorage } from '@ethosagent/storage-fs';
import type { AmendmentRecord } from '@ethosagent/types';
import type { AmendmentReview } from '@ethosagent/wiring';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWebApi, WebTokenRepository } from '../../index';
import { SCOPE_MAP } from '../../middleware/dual-auth';
import { apiRouter } from '../../rpc/router';
import type { AmendmentReader } from '../../services/amendments.service';
import {
  makeStubAgentLoop,
  makeStubMemoryBundle,
  makeStubPersonalityRegistry,
} from '../test-helpers';

// plan personality-memory-boundary-and-self-amendment G2, D30 — the web's
// READ-ONLY view of self-amendments, end to end through `createWebApi`:
// `amendments.list | get` answer a cookie session from the injected reader,
// refuse every bearer key (the namespace is absent from SCOPE_MAP), and have
// no write procedure at all. Apply lives in the TTY-gated CLI.

const RECORD: AmendmentRecord = {
  schemaVersion: 1,
  id: 'a-abc-1',
  personalityId: 'researcher',
  target: 'toolset',
  ops: [{ op: 'add_tool', tool: 'web_fetch' }],
  opsHash: 'o'.repeat(64),
  baseHash: 'b'.repeat(64),
  rationale: 'fetches keep failing',
  evidence: [],
  provenance: {
    sessionId: 's-1',
    sessionKey: 'cli:amend',
    platform: 'cli',
    initiator: 'user',
    roomAudience: 'private',
    executionPosture: 'docker',
    holdsShellTool: false,
  },
  preCheck: 'ok',
  status: 'pending',
  history: [{ action: 'filed', actor: 'intake', at: '2026-09-28T00:00:00.000Z' }],
  createdAt: '2026-09-28T00:00:00.000Z',
  updatedAt: '2026-09-28T00:00:00.000Z',
};

const REVIEW: AmendmentReview = {
  record: RECORD,
  personality: 'ok',
  liveBytes: '- read_file\n',
  liveHash: 'b'.repeat(64),
  stale: false,
  interruptedApply: false,
  afterBytes: '- read_file\n- web_fetch\n',
  expectedAfterHash: 'e'.repeat(64),
  textDiff: [' - read_file', '+- web_fetch'],
  rollbackDiff: [],
  permissionDiff: {
    changes: [{ section: 'Toolset', field: 'toolset', direction: 'widens', detail: '+ web_fetch' }],
    widens: true,
  },
  notCompared: 'Not compared: SOUL.md',
  flags: ['no-recorded-refusal'],
};

describe('amendments RPC (read-only, cookie-only)', () => {
  let dataDir: string;
  let store: SQLiteSessionStore;
  let keys: SqliteApiKeyStore;
  let cookie: string;

  async function boot(amendments?: AmendmentReader) {
    const app = createWebApi({
      dataDir,
      sessionStore: store,
      memoryBundle: makeStubMemoryBundle(),
      agentLoop: makeStubAgentLoop(),
      personalities: makeStubPersonalityRegistry(),
      chatDefaults: { model: 'claude-test', provider: 'anthropic' },
      apiKeys: keys,
      ...(amendments ? { amendments } : {}),
    }).app;
    const tokens = new WebTokenRepository({ dataDir, storage: new FsStorage() });
    const token = await tokens.getOrCreate();
    const exchange = await app.request(`/auth/exchange?t=${token}`, {
      headers: { origin: 'http://localhost:3000', host: 'localhost:3000' },
    });
    cookie = (exchange.headers.get('set-cookie') ?? '').split(/;\s*/)[0] ?? '';
    return app;
  }

  const call = (
    app: Awaited<ReturnType<typeof boot>>,
    method: string,
    input: unknown,
    auth: { cookie: string } | { bearer: string },
  ) =>
    app.request(`/rpc/amendments/${method}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost:3000',
        host: 'localhost:3000',
        ...('cookie' in auth
          ? { cookie: auth.cookie }
          : { authorization: `Bearer ${auth.bearer}` }),
      },
      body: JSON.stringify({ json: input }),
    });

  function reader(): AmendmentReader & { list: ReturnType<typeof vi.fn> } {
    return {
      list: vi.fn(async () => [RECORD]),
      get: vi.fn(async (id: string) => (id === RECORD.id ? REVIEW : null)),
    };
  }

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'ethos-amendments-rpc-'));
    store = new SQLiteSessionStore(':memory:');
    keys = new SqliteApiKeyStore(':memory:');
  });

  afterEach(async () => {
    store.close();
    keys.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('list answers a cookie session from the injected reader, forwarding the filter', async () => {
    const r = reader();
    const app = await boot(r);
    const res = await call(app, 'list', { statuses: ['pending'] }, { cookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { json: { amendments: AmendmentRecord[] } };
    expect(body.json.amendments).toEqual([RECORD]);
    expect(r.list).toHaveBeenCalledWith({ status: ['pending'] });
  });

  it('get returns the review without the raw live/after bytes', async () => {
    const app = await boot(reader());
    const res = await call(app, 'get', { amendmentId: RECORD.id }, { cookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { json: { review: Record<string, unknown> } };
    expect(body.json.review.expectedAfterHash).toBe('e'.repeat(64));
    expect(body.json.review.textDiff).toEqual([' - read_file', '+- web_fetch']);
    expect('liveBytes' in body.json.review).toBe(false);
    expect('afterBytes' in body.json.review).toBe(false);
  });

  it('get of an unknown id is NOT_FOUND', async () => {
    const app = await boot(reader());
    const res = await call(app, 'get', { amendmentId: 'a-nope-1' }, { cookie });
    expect(res.status).toBe(404);
  });

  it('with no reader (onboarding, before a loop exists) answers NOT_CONFIGURED, not an empty list', async () => {
    const app = await boot();
    const res = await call(app, 'list', {}, { cookie });
    expect(res.status).toBe(503);
  });

  it('refuses every bearer key, whatever its scopes', async () => {
    const r = reader();
    const app = await boot(r);
    const created = await keys.create({
      name: 'all-read',
      scopes: ['sessions:read', 'personalities:read', 'tools:approve', 'chat:send'],
    });
    for (const method of ['list', 'get']) {
      const res = await call(app, method, { amendmentId: RECORD.id }, { bearer: created.secret });
      expect(res.status).toBe(403);
    }
    expect(r.list).not.toHaveBeenCalled();
    expect(SCOPE_MAP.amendments).toBeUndefined();
  });

  it('has no write procedure: the namespace is list and get only', () => {
    expect(Object.keys((apiRouter as Record<string, object>).amendments ?? {}).sort()).toEqual([
      'get',
      'list',
    ]);
  });
});
