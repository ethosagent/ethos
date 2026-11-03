import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { FsStorage } from '@ethosagent/storage-fs';
import type { BackgroundJob, JobStore } from '@ethosagent/types';
import type { CreateAgentLoopResult } from '@ethosagent/wiring';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWebApi, WebTokenRepository } from '../../index';
import {
  makeStubAgentLoop,
  makeStubMemoryBundle,
  makeStubPersonalityRegistry,
} from '../test-helpers';

// Wire contract of `tasks.steer` / `tasks.events` (plan background-job-steer
// §5.4): the status code per failure, and the success bodies. The outcome →
// status mapping lives in rpc/tasks.ts; JobControl itself is faked here.

type Control = NonNullable<CreateAgentLoopResult['jobControl']>;
type SteerOutcome = Awaited<ReturnType<Control['steer']>>;

const JOB = {
  id: 'job-1',
  status: 'running',
  prompt: 'ship it',
  spendUsd: 0,
  depth: 1,
  createdAt: 1_000,
  owner: 'host',
  rootSessionKey: 'web:s',
  parentSessionKey: 'web:s',
  childSessionKey: 'web:s:job:x:1',
} as BackgroundJob;

describe('tasks.steer / tasks.events RPC', () => {
  let dataDir: string;
  let sessions: SQLiteSessionStore;
  let app: ReturnType<typeof createWebApi>['app'];
  let cookie: string;
  let outcome: SteerOutcome;
  let withControl: boolean;

  const build = async () => {
    const jobStore = {
      get: async (id: string) => (id === JOB.id ? JOB : null),
    } as unknown as JobStore;
    const jobControl = {
      capabilitiesFor: () => null,
      steer: async () => outcome,
      stop: async () => ({ ok: true, wasRunning: true }),
      tail: async (_job, req) => ({
        ok: true,
        events: [
          {
            id: 903,
            jobId: 'job-1',
            seq: (req.afterSeq ?? 0) + 1,
            eventType: 'text',
            payload: { text: 'hello' },
            createdAt: 1_760,
          },
        ],
      }),
      steers: async () => [],
    } satisfies Control;
    app = createWebApi({
      dataDir,
      sessionStore: sessions,
      memoryBundle: makeStubMemoryBundle(),
      agentLoop: makeStubAgentLoop(),
      personalities: makeStubPersonalityRegistry(),
      chatDefaults: { model: 'claude-test', provider: 'anthropic' },
      jobStore,
      ...(withControl ? { jobControl } : {}),
    }).app;
    const tokens = new WebTokenRepository({ dataDir, storage: new FsStorage() });
    const token = await tokens.getOrCreate();
    const exchange = await app.request(`/auth/exchange?t=${token}`, {
      headers: { origin: 'http://localhost:3000', host: 'localhost:3000' },
    });
    cookie = (exchange.headers.get('set-cookie') ?? '').split(/;\s*/)[0] ?? '';
  };

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'ethos-tasks-rpc-'));
    sessions = new SQLiteSessionStore(':memory:');
    outcome = { ok: true, steerId: 17 };
    withControl = true;
  });

  afterEach(async () => {
    sessions.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const call = async (name: string, json: unknown) => {
    const res = await app.request(`/rpc/tasks/${name}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: 'http://localhost:3000',
        host: 'localhost:3000',
      },
      body: JSON.stringify({ json }),
    });
    const body = (await res.json()) as { json?: unknown };
    return { status: res.status, body: body.json };
  };

  it('steer 200 returns the steer id', async () => {
    await build();
    expect(await call('steer', { id: 'job-1', text: 'skip the tests' })).toEqual({
      status: 200,
      body: { steerId: 17 },
    });
  });

  it('steer 400 on empty text and on text over 4000 chars', async () => {
    await build();
    expect((await call('steer', { id: 'job-1', text: '' })).status).toBe(400);
    expect((await call('steer', { id: 'job-1', text: 'x'.repeat(4001) })).status).toBe(400);
  });

  it('steer 400 on whitespace-only text', async () => {
    await build();
    expect((await call('steer', { id: 'job-1', text: '   \n\t ' })).status).toBe(400);
  });

  it('steer 404 for an unknown job', async () => {
    await build();
    expect((await call('steer', { id: 'nope', text: 'hi' })).status).toBe(404);
  });

  it.each<[SteerOutcome, number, RegExp]>([
    [{ ok: false, reason: 'not_found' }, 404, /not found/],
    [{ ok: false, reason: 'finished', status: 'done' }, 409, /already finished \(done\)/],
    [{ ok: false, reason: 'remote' }, 409, /remote/],
    [{ ok: false, reason: 'unsupported' }, 409, /cannot take steers/],
    [{ ok: false, reason: 'full' }, 429, /32 unread/],
    [{ ok: false, reason: 'too_long' }, 400, /too long/],
    [{ ok: false, reason: 'not_available' }, 503, /not available/],
  ])('steer maps %j to %i', async (out, status, message) => {
    outcome = out;
    await build();
    const res = await call('steer', { id: 'job-1', text: 'hi' });
    expect(res.status).toBe(status);
    expect(JSON.stringify(res.body)).toMatch(message);
  });

  it('steer 503 when background control is not wired', async () => {
    withControl = false;
    await build();
    expect((await call('steer', { id: 'job-1', text: 'hi' })).status).toBe(503);
  });

  it('events 200 returns rows after the cursor', async () => {
    await build();
    const res = await call('events', { id: 'job-1', afterSeq: 41, limit: 100 });
    expect(res).toEqual({
      status: 200,
      body: [
        {
          id: 903,
          jobId: 'job-1',
          seq: 42,
          eventType: 'text',
          payload: { text: 'hello' },
          createdAt: 1_760,
        },
      ],
    });
  });

  it('events 404 for an unknown job', async () => {
    await build();
    expect((await call('events', { id: 'nope' })).status).toBe(404);
  });
});
