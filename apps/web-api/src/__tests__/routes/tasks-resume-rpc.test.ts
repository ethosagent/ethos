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

// Wire contract of `tasks.resume`: the status code per outcome. The mapping
// lives in rpc/tasks.ts (`refuse`); JobControl itself is faked here.

type Control = NonNullable<CreateAgentLoopResult['jobControl']>;
type ResumeOutcome = Awaited<ReturnType<Control['resume']>>;

const JOB = {
  id: 'job-1',
  status: 'stale',
  prompt: 'ship it',
  spendUsd: 0,
  depth: 1,
  createdAt: 1_000,
  owner: 'host',
  rootSessionKey: 'web:s',
  parentSessionKey: 'web:s',
  childSessionKey: 'web:s:job:x:1',
} as BackgroundJob;

describe('tasks.resume RPC', () => {
  let dataDir: string;
  let sessions: SQLiteSessionStore;
  let app: ReturnType<typeof createWebApi>['app'];
  let cookie: string;
  let outcome: ResumeOutcome;
  let withControl: boolean;

  const build = async () => {
    const jobStore = {
      get: async (id: string) => (id === JOB.id ? JOB : null),
    } as unknown as JobStore;
    const jobControl = {
      capabilitiesFor: () => null,
      steer: async () => ({ ok: true, steerId: 1 }),
      stop: async () => ({ ok: true, wasRunning: true }),
      tail: async () => ({ ok: true, events: [] }),
      steers: async () => [],
      resume: async () => outcome,
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
    dataDir = await mkdtemp(join(tmpdir(), 'ethos-tasks-resume-rpc-'));
    sessions = new SQLiteSessionStore(':memory:');
    outcome = { ok: true };
    withControl = true;
  });

  afterEach(async () => {
    sessions.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const resume = async (id: string) => {
    const res = await app.request('/rpc/tasks/resume', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: 'http://localhost:3000',
        host: 'localhost:3000',
      },
      body: JSON.stringify({ json: { id } }),
    });
    const text = await res.text();
    return { status: res.status, text };
  };

  it('200 when the job was requeued', async () => {
    await build();
    expect((await resume('job-1')).status).toBe(200);
  });

  it('404 for an unknown job', async () => {
    await build();
    expect((await resume('nope')).status).toBe(404);
  });

  it.each<[ResumeOutcome, number, RegExp]>([
    [{ ok: false, reason: 'not_found' }, 404, /not found/],
    [{ ok: false, reason: 'not_stale', status: 'running' }, 409, /not stale \(running\)/],
    [{ ok: false, reason: 'unsupported' }, 409, /cannot resume/],
    [{ ok: false, reason: 'not_available' }, 503, /not available/],
  ])('maps %j to %i', async (out, status, message) => {
    outcome = out;
    await build();
    const res = await resume('job-1');
    expect(res.status).toBe(status);
    expect(res.text).toMatch(message);
  });

  it('503 when background control is not wired', async () => {
    withControl = false;
    await build();
    expect((await resume('job-1')).status).toBe(503);
  });
});
