import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { FsStorage } from '@ethosagent/storage-fs';
import { SkillSchema, SkillVersionSchema } from '@ethosagent/web-contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWebApi, WebTokenRepository } from '../../index';
import {
  makeStubAgentLoop,
  makeStubMemoryBundle,
  makeStubPersonalityRegistry,
} from '../test-helpers';

// Plan skill-history-and-lock, D1: `skills.history / version / restore / setLock`
// driven through the real router, for a shared skill and a personality's own.

describe('skills RPC — history, restore and lock', () => {
  let dataDir: string;
  let store: SQLiteSessionStore;
  let app: ReturnType<typeof createWebApi>['app'];
  let cookie: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'ethos-skills-history-'));
    await mkdir(join(dataDir, 'personalities'), { recursive: true });
    store = new SQLiteSessionStore(':memory:');
    app = createWebApi({
      dataDir,
      sessionStore: store,
      memoryBundle: makeStubMemoryBundle(),
      agentLoop: makeStubAgentLoop(),
      personalities: makeStubPersonalityRegistry([], dataDir),
      chatDefaults: { model: 'claude-test', provider: 'anthropic' },
    }).app;
    const tokens = new WebTokenRepository({ dataDir, storage: new FsStorage() });
    const token = await tokens.getOrCreate();
    const exchange = await app.request(`/auth/exchange?t=${token}`, {
      headers: { origin: 'http://localhost:3000', host: 'localhost:3000' },
    });
    cookie = (exchange.headers.get('set-cookie') ?? '').split(/;\s*/)[0] ?? '';
  });

  afterEach(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const call = async (ns: string, method: string, input: unknown) => {
    const res = await app.request(`/rpc/${ns}/${method}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: 'http://localhost:3000',
        host: 'localhost:3000',
      },
      body: JSON.stringify({ json: input }),
    });
    return { status: res.status, body: (await res.json()) as { json: Record<string, unknown> } };
  };

  function versionsOf(body: { json: Record<string, unknown> }) {
    const parsed = SkillVersionSchema.array().safeParse(body.json.versions);
    if (!parsed.success) throw new Error(`versions failed contract parse: ${parsed.error}`);
    return parsed.data;
  }

  it('shared skill: create, edit, history, version bytes, restore, lock', async () => {
    expect((await call('skills', 'create', { id: 'tidy', body: 'one' })).status).toBe(200);
    expect((await call('skills', 'update', { id: 'tidy', body: 'two' })).status).toBe(200);

    const history = await call('skills', 'history', { id: 'tidy' });
    expect(history.status).toBe(200);
    const versions = versionsOf(history.body);
    expect(versions.map((v) => v.source)).toEqual(['web-edit', 'web-edit']);
    const first = versions[0];
    if (!first) throw new Error('no versions');

    const bytes = await call('skills', 'version', { id: 'tidy', versionId: first.versionId });
    expect(bytes.body.json).toEqual({ versionId: first.versionId, content: 'one\n' });

    const restored = await call('skills', 'restore', { id: 'tidy', versionId: first.versionId });
    expect(restored.status).toBe(200);
    expect(await readFile(join(dataDir, 'skills', 'tidy.md'), 'utf8')).toBe('one\n');
    const after = versionsOf((await call('skills', 'history', { id: 'tidy' })).body);
    expect(after.at(-1)).toMatchObject({ source: 'restore', restoredFrom: first.versionId });

    const locked = await call('skills', 'setLock', { id: 'tidy', locked: true });
    expect(locked.body.json).toEqual({ locked: true });
    const list = await call('skills', 'list', {});
    const skill = SkillSchema.array().parse(list.body.json.skills)[0];
    expect(skill).toMatchObject({ id: 'tidy', locked: true, versionCount: 3 });
  });

  it('personality skill: personalityId selects the personality dir, not the shared one', async () => {
    await mkdir(join(dataDir, 'personalities', 'coach', 'skills'), { recursive: true });
    await call('skills', 'create', { id: 'tidy', body: 'shared' });
    // A hand-written personality skill: the first look records an `external` baseline.
    await writeFile(join(dataDir, 'personalities', 'coach', 'skills', 'tidy.md'), 'mine\n');

    const scoped = versionsOf(
      (await call('skills', 'history', { id: 'tidy', personalityId: 'coach' })).body,
    );
    expect(scoped.map((v) => v.source)).toEqual(['external']);
    expect(
      (await call('skills', 'setLock', { id: 'tidy', personalityId: 'coach', locked: true })).body
        .json,
    ).toEqual({ locked: true });
    const shared = await call('skills', 'list', {});
    expect(SkillSchema.array().parse(shared.body.json.skills)[0]?.locked).toBe(false);
  });

  it('an unknown version restores as a 4xx and changes nothing', async () => {
    await call('skills', 'create', { id: 'tidy', body: 'one' });
    const res = await call('skills', 'restore', { id: 'tidy', versionId: 'nope' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await readFile(join(dataDir, 'skills', 'tidy.md'), 'utf8')).toBe('one\n');
  });
});
