import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DefaultWorldGraphProviderRegistry } from '@ethosagent/core';
import { noopLogger } from '@ethosagent/logger';
import { SQLiteSessionStore, SqliteApiKeyStore } from '@ethosagent/session-sqlite';
import { FsStorage } from '@ethosagent/storage-fs';
import { createWorldRuntime, type WorldRuntime } from '@ethosagent/wiring';
import { SQLiteWorldServiceStore, serviceDbPath } from '@ethosagent/world-service';
import { SQLiteWorldGraphProvider, worldGraphDbPath } from '@ethosagent/world-sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWebApi, WebTokenRepository } from '../../index';
import {
  makeStubAgentLoop,
  makeStubMemoryBundle,
  makeStubPersonalityRegistry,
} from '../test-helpers';

// plan world-model 7.2: the owner's `worlds.*` RPC over the REAL world runtime
// (createWorldRuntime: WorldService, WorldSchemaService, WorldConfigService, the sqlite
// backend), behind cookie auth and CSRF. Error codes are the plan's wire codes: NOT_FOUND 404,
// CONFLICT 409, INPUT_INVALID 400.

const ORIGIN = 'http://localhost:3000';
const SCHEMA_YAML = `version: 1
entities:
  Person:
    attrs:
      title: { type: string }
  Team: { attrs: {} }
edges:
  member_of: { from: [Person], to: [Team], attrs: {} }
`;

interface Reply<T = Record<string, unknown>> {
  status: number;
  body: T & { code?: string; message?: string };
}

describe('worlds RPC', () => {
  let dataDir: string;
  let sessions: SQLiteSessionStore;
  let keys: SqliteApiKeyStore;
  let runtime: WorldRuntime;
  let app: ReturnType<typeof createWebApi>['app'];
  let cookie: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'ethos-worlds-rpc-'));
    sessions = new SQLiteSessionStore(':memory:');
    keys = new SqliteApiKeyStore(':memory:');
    const providers = new DefaultWorldGraphProviderRegistry();
    providers.register(
      'sqlite',
      ({ dataDir: dir }) => new SQLiteWorldGraphProvider(worldGraphDbPath(dir)),
    );
    runtime = createWorldRuntime({
      dataDir,
      storage: new FsStorage(),
      config: { enabled: true },
      providers,
      secrets: {
        get: async () => null,
        set: async () => {},
        delete: async () => {},
        list: async () => [],
      },
      logger: noopLogger,
      sanitize: (s) => s,
    });
    app = createWebApi({
      dataDir,
      sessionStore: sessions,
      memoryBundle: makeStubMemoryBundle(),
      agentLoop: makeStubAgentLoop(),
      personalities: makeStubPersonalityRegistry([
        { id: 'engineer', name: 'Engineer' },
        { id: 'curator', name: 'Curator' },
      ]),
      chatDefaults: { model: 'claude-test', provider: 'anthropic' },
      apiKeys: keys,
      worlds: runtime,
    }).app;
    const token = await new WebTokenRepository({ dataDir, storage: new FsStorage() }).getOrCreate();
    const exchange = await app.request(`/auth/exchange?t=${token}`, {
      headers: { origin: ORIGIN, host: 'localhost:3000' },
    });
    cookie = (exchange.headers.get('set-cookie') ?? '').split(/;\s*/)[0] ?? '';

    await runtime.configService.writeWorld(
      {
        id: 'acme',
        title: 'Acme company',
        audience: 'owner_only',
        readers: ['curator'],
        proposers: ['engineer'],
      },
      { by: 'test' },
    );
    await runtime.configService.writeWorld(
      { id: 'watchlist', title: 'Watchlist', readers: ['engineer'], proposers: [] },
      { by: 'test' },
    );
  });

  afterEach(async () => {
    runtime.close();
    sessions.close();
    keys.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function call<T = Record<string, unknown>>(
    method: string,
    input: unknown,
    headers: Record<string, string> = {},
  ): Promise<Reply<T>> {
    const res = await app.request(`/rpc/worlds/${method}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: ORIGIN,
        host: 'localhost:3000',
        ...headers,
      },
      body: JSON.stringify({ json: input }),
    });
    const parsed = (await res.json()) as { json?: T & { code?: string; message?: string } };
    return { status: res.status, body: parsed.json ?? ({} as never) };
  }

  const must = <T>(r: Reply<T>): Reply<T>['body'] => {
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body;
  };

  async function seedSchema(world = 'world:acme'): Promise<void> {
    must(await call('schemaSave', { world, yaml: SCHEMA_YAML, expectedVersion: 0 }));
  }

  async function write(world: string, fact: unknown): Promise<string> {
    const body = must(await call<{ ids: string[] }>('factWrite', { world, fact }));
    const id = body.ids[0];
    if (!id) throw new Error('no id');
    return id;
  }

  // The agent proposing on the shared world, as a mounted personality would.
  async function agentProposes(facts: Parameters<WorldRuntime['service']['writeFacts']>[2]) {
    await runtime.configService.writeMounts(
      'engineer',
      { mounts: [{ world: 'acme', mode: 'propose' }] },
      { by: 'test' },
    );
    return runtime.service.writeFacts(
      { personalityId: 'engineer', audience: 'private', sessionId: 's1', surface: 'tool' },
      'acme',
      facts,
      'seen in chat',
    );
  }

  // ---- auth ---------------------------------------------------------------

  it('401 without a cookie', async () => {
    const res = await call('list', {}, { cookie: '' });
    expect(res.status).toBe(401);
  });

  it('bearer key is refused', async () => {
    const { secret } = await keys.create({
      name: 'wide',
      scopes: ['sessions:read', 'sessions:write', 'chat:send', 'memory:read', 'memory:write'],
    });
    const res = await app.request('/rpc/worlds/list', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: JSON.stringify({ json: {} }),
    });
    expect(res.status).toBe(403);
  });

  it('missing CSRF is refused', async () => {
    const res = await app.request('/rpc/worlds/list', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, host: 'localhost:3000' },
      body: JSON.stringify({ json: {} }),
    });
    // The shared CSRF middleware answers a missing Origin with its UNAUTHORIZED code (401).
    expect([401, 403]).toContain(res.status);
    const hostile = await app.request('/rpc/worlds/list', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
        host: 'localhost:3000',
        origin: 'http://evil.example',
      },
      body: JSON.stringify({ json: {} }),
    });
    expect([401, 403]).toContain(hostile.status);
  });

  it('503 NOT_CONFIGURED when the world model is off', async () => {
    const { app: bare } = createWebApi({
      dataDir,
      sessionStore: sessions,
      memoryBundle: makeStubMemoryBundle(),
      agentLoop: makeStubAgentLoop(),
      personalities: makeStubPersonalityRegistry(),
      chatDefaults: { model: 'claude-test', provider: 'anthropic' },
    });
    const token = await new WebTokenRepository({ dataDir, storage: new FsStorage() }).getOrCreate();
    const ex = await bare.request(`/auth/exchange?t=${token}`, {
      headers: { origin: ORIGIN, host: 'localhost:3000' },
    });
    const c = (ex.headers.get('set-cookie') ?? '').split(/;\s*/)[0] ?? '';
    const res = await bare.request('/rpc/worlds/list', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: c,
        origin: ORIGIN,
        host: 'localhost:3000',
      },
      body: JSON.stringify({ json: {} }),
    });
    expect(res.status).toBe(503);
  });

  // ---- list ---------------------------------------------------------------

  it('list shows shared and private worlds with counts and mounts', async () => {
    await seedSchema();
    await write('world:acme', { kind: 'entity', type: 'Person', name: 'Ravi' });
    await runtime.configService.writeMounts(
      'engineer',
      { mounts: [{ world: 'acme', mode: 'propose' }] },
      { by: 'test' },
    );
    await runtime.configService.writeMounts(
      'curator',
      { mounts: [{ world: 'acme', mode: 'propose' }] },
      { by: 'test' },
    );
    const body = must(
      await call<{
        worlds: Array<{
          id: string;
          audience: string;
          backend: string;
          counts: { entities: number; liveEdges: number; pendingProposals: number };
          mountedBy: Array<{
            personalityId: string;
            mode: string;
            effective: string;
            note?: string;
          }>;
        }>;
      }>('list', {}),
    );
    const acme = body.worlds.find((w) => w.id === 'world:acme');
    expect(acme).toMatchObject({
      title: 'Acme company',
      audience: 'owner_only',
      backend: 'sqlite',
      counts: { entities: 1, liveEdges: 0, pendingProposals: 0 },
    });
    expect(acme?.mountedBy).toEqual([
      { personalityId: 'engineer', mode: 'propose', effective: 'propose' },
      { personalityId: 'curator', mode: 'propose', effective: 'read', note: 'not in proposers' },
    ]);
    // The owner sees every personality's private world too.
    expect(body.worlds.map((w) => w.id)).toEqual(
      expect.arrayContaining(['world:watchlist', 'personality:engineer', 'personality:curator']),
    );
  });

  // ---- graph, tree, entity ------------------------------------------------

  it('graph, tree and entity read the world; an unknown entity is 404 NOT_FOUND', async () => {
    await seedSchema();
    const ravi = await write('world:acme', { kind: 'entity', type: 'Person', name: 'Ravi' });
    const core = await write('world:acme', { kind: 'entity', type: 'Team', name: 'Core' });
    await write('world:acme', { kind: 'edge', type: 'member_of', fromId: ravi, toId: core });
    await write('world:acme', { kind: 'attribute', entityId: ravi, key: 'title', value: 'SRE' });

    const graph = must(
      await call<{
        nodes: Array<{ id: string; isNew: boolean }>;
        edges: Array<{ type: string; author: string; validTo: string | null }>;
        truncated: boolean;
      }>('graph', { world: 'world:acme' }),
    );
    expect(graph.nodes.map((n) => n.id).sort()).toEqual([ravi, core].sort());
    expect(graph.edges).toMatchObject([{ type: 'member_of', author: 'user', validTo: null }]);
    expect(graph.truncated).toBe(false);

    const focused = must(
      await call<{ nodes: unknown[] }>('graph', {
        world: 'world:acme',
        focus: ravi,
        hops: 1,
        types: ['Person', 'Team'],
        limit: 300,
      }),
    );
    expect(focused.nodes).toHaveLength(2);

    const missing = await call('graph', { world: 'world:acme', focus: 'e-9f2c01ab33de4410' });
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({
      code: 'NOT_FOUND',
      message: 'world:acme has no entity e-9f2c01ab33de4410',
    });

    const tree = must(
      await call<{
        groups: Array<{ type: string; entities: Array<{ name: string; edgeCount: number }> }>;
      }>('tree', { world: 'world:acme' }),
    );
    expect(tree.groups.map((g) => g.type)).toEqual(['Person', 'Team']);
    expect(tree.groups[0]?.entities[0]).toMatchObject({ name: 'Ravi', edgeCount: 1 });

    const entity = must(
      await call<{
        name: string;
        facts: Array<{ key: string; author: string; sourceRef: string; promotable: boolean }>;
        edges: Array<{ direction: string; otherName: string }>;
      }>('entity', { world: 'world:acme', entityId: ravi }),
    );
    expect(entity.name).toBe('Ravi');
    expect(entity.facts).toMatchObject([{ key: 'title', author: 'user', promotable: false }]);
    expect(entity.facts[0]?.sourceRef).toMatch(/^web:/);
    expect(entity.edges).toMatchObject([{ direction: 'out', otherName: 'Core' }]);

    expect((await call('entity', { world: 'world:acme', entityId: 'e-nope' })).status).toBe(404);
    expect((await call('graph', { world: 'world:ghost' })).status).toBe(404);
  });

  it('changes groups by source', async () => {
    await seedSchema();
    await write('world:acme', { kind: 'entity', type: 'Person', name: 'Ravi' });
    const body = must(
      await call<{ groups: Array<{ author: string; changes: Array<{ summary: string }> }> }>(
        'changes',
        { world: 'world:acme', since: '2000-01-01' },
      ),
    );
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0]?.author).toBe('user');
    expect(body.groups[0]?.changes[0]?.summary).toBe('Person Ravi');
  });

  // ---- owner writes -------------------------------------------------------

  it('owner write is authored user', async () => {
    await seedSchema();
    const ravi = await write('world:acme', { kind: 'entity', type: 'Person', name: 'Ravi' });
    const attr = await write('world:acme', {
      kind: 'attribute',
      entityId: ravi,
      key: 'title',
      value: 'SRE',
    });
    const bundle = await runtime.service.ownerExport('world:acme');
    expect(bundle.entities.find((e) => e.id === ravi)?.author).toBe('user');
    expect(bundle.attributes.find((a) => a.id === attr)).toMatchObject({
      author: 'user',
      sourceRef: expect.stringMatching(/^web:/),
    });
  });

  it("factClose closes a fact; promote makes an agent fact the owner's", async () => {
    await seedSchema();
    const ravi = await write('world:acme', { kind: 'entity', type: 'Person', name: 'Ravi' });
    const attr = await write('world:acme', {
      kind: 'attribute',
      entityId: ravi,
      key: 'title',
      value: 'SRE',
    });
    must(await call('factClose', { world: 'world:acme', factId: attr, validTo: '2026-11-01' }));
    const again = await call('factClose', { world: 'world:acme', factId: attr });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('CONFLICT');
    expect((await call('factClose', { world: 'world:acme', factId: 'a-nope' })).status).toBe(404);

    // An agent fact on a private world, then promoted.
    await runtime.schema.apply(
      'personality:engineer',
      { op: 'add_entity_type', type: 'Person', attrs: { title: { type: 'string' } } },
      { kind: 'user', id: 'test' },
      'seed',
    );
    const provider = new SQLiteWorldGraphProvider(worldGraphDbPath(dataDir));
    const person = await provider.assert('personality:engineer', [
      { kind: 'entity', type: 'Person', name: 'Priya', sourceRef: 'chat:1', author: 'agent' },
    ]);
    const personId = person.ok ? person.ids[0] : undefined;
    const fact = await provider.assert('personality:engineer', [
      {
        kind: 'attribute',
        entityId: personId ?? '',
        key: 'title',
        value: 'PM',
        sourceRef: 'chat:1',
        author: 'agent',
        confidence: 0.9,
      },
    ]);
    provider.dispose();
    const id = fact.ok ? fact.ids[0] : undefined;
    expect(id).toBeDefined();
    const promoted = must(
      await call<{ factId: string }>('promote', {
        world: 'personality:engineer',
        factId: id ?? '',
      }),
    );
    expect(promoted.factId).not.toBe(id);
  });

  // ---- proposals ----------------------------------------------------------

  it('proposals list conflicts first; decide records decided_by', async () => {
    await seedSchema();
    const ravi = await write('world:acme', { kind: 'entity', type: 'Person', name: 'Ravi' });
    const title = await write('world:acme', {
      kind: 'attribute',
      entityId: ravi,
      key: 'title',
      value: 'Engineer',
    });
    await agentProposes([
      { kind: 'entity', type: 'Person', name: 'Priya', sourceRef: 'chat:1', author: 'agent' },
    ]);
    await agentProposes([
      {
        kind: 'attribute',
        entityId: ravi,
        key: 'title',
        value: 'Manager',
        sourceRef: 'chat:2',
        author: 'agent',
        confidence: 0.9,
      },
    ]);

    const list = must(
      await call<{
        proposals: Array<{ id: string; conflictWith: string | null; status: string; kind: string }>;
      }>('proposals', { world: 'world:acme', status: 'pending' }),
    );
    expect(list.proposals).toHaveLength(2);
    expect(list.proposals[0]?.conflictWith).toBe(title);
    expect(list.proposals[1]?.conflictWith).toBeNull();

    const conflict = list.proposals[0];
    const plain = list.proposals[1];
    if (!conflict || !plain) throw new Error('missing proposals');
    const accepted = must(
      await call<{ ok: boolean; applied: string[]; closed: string[] }>('decide', {
        proposalId: conflict.id,
        verdict: 'accept',
      }),
    );
    expect(accepted.ok).toBe(true);
    expect(accepted.applied).toHaveLength(1);
    expect(accepted.closed).toEqual([title]);
    expect(runtime.service.ownerProposal(conflict.id)).toMatchObject({
      status: 'accepted',
      decidedBy: expect.stringMatching(/^web:/),
    });

    must(await call('decide', { proposalId: plain.id, verdict: 'reject', reason: 'no' }));
    expect(runtime.service.ownerProposal(plain.id)).toMatchObject({
      status: 'rejected',
      decidedBy: expect.stringMatching(/^web:/),
      reason: 'no',
    });

    const again = await call('decide', { proposalId: plain.id, verdict: 'accept' });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({
      code: 'CONFLICT',
      message: `${plain.id} is already rejected`,
    });
    expect((await call('decide', { proposalId: 'p-nope', verdict: 'accept' })).status).toBe(404);
  });

  // ---- schema -------------------------------------------------------------

  it('schemaSave: 200 version, 400 INPUT_INVALID with the line, 409 CONFLICT on a stale version', async () => {
    const saved = must(
      await call<{ ok: boolean; version: number }>('schemaSave', {
        world: 'world:acme',
        yaml: SCHEMA_YAML,
        expectedVersion: 0,
      }),
    );
    expect(saved).toEqual({ ok: true, version: 1 });

    const stale = await call('schemaSave', {
      world: 'world:acme',
      yaml: SCHEMA_YAML,
      expectedVersion: 0,
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({
      code: 'CONFLICT',
      message: 'schema is at version 1, expected 0',
    });

    const bad = await call('schemaSave', {
      world: 'world:acme',
      yaml: 'version: 2\nentities:\n  Person:\n    attrs:\n      title: { type: number5 }\n',
      expectedVersion: 1,
    });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('INPUT_INVALID');
    expect(bad.body.message).toMatch(/line \d+/);

    const read = must(
      await call<{
        version: number;
        yaml: string;
        parsed: { entities: Record<string, unknown> } | null;
        loadErrors: unknown[];
      }>('schema', { world: 'world:acme' }),
    );
    expect(read.version).toBe(1);
    expect(read.yaml).toBe(SCHEMA_YAML);
    expect(Object.keys(read.parsed?.entities ?? {})).toEqual(['Person', 'Team']);
    expect(read.loadErrors).toEqual([]);
  });

  // ---- config -------------------------------------------------------------

  it('config reads and configSave rewrites world.yaml, keeping id and backend', async () => {
    const before = must(
      await call<{ id: string; backend: string; readers: string[] }>('config', {
        world: 'world:acme',
      }),
    );
    expect(before).toMatchObject({ id: 'acme', backend: 'sqlite', readers: ['curator'] });
    must(
      await call('configSave', {
        world: 'world:acme',
        title: 'Acme Inc',
        audience: 'shareable',
        readers: ['curator', 'engineer'],
        proposers: ['engineer'],
      }),
    );
    expect(await runtime.configService.readWorld('acme')).toMatchObject({
      id: 'acme',
      backend: 'sqlite',
      title: 'Acme Inc',
      audience: 'shareable',
      readers: ['curator', 'engineer'],
    });
    const dup = await call('configSave', {
      world: 'world:acme',
      title: 'x',
      audience: 'owner_only',
      readers: ['curator', 'curator'],
      proposers: [],
    });
    expect(dup.status).toBe(400);
    expect(dup.body.code).toBe('INPUT_INVALID');
    expect((await call('config', { world: 'personality:engineer' })).status).toBe(404);
  });

  // ---- mounts -------------------------------------------------------------

  it('mountsSave reports inert mounts', async () => {
    const saved = must(
      await call<{
        ok: boolean;
        effective: Array<{ world: string; effective: string; note?: string }>;
      }>('mountsSave', {
        personalityId: 'engineer',
        mounts: [
          { world: 'acme', mode: 'read' },
          { world: 'watchlist', mode: 'propose', as: 'stocks' },
          { world: 'ghost', mode: 'read' },
        ],
      }),
    );
    expect(saved.ok).toBe(true);
    expect(saved.effective[0]).toEqual({ world: 'acme', effective: 'read' });
    expect(saved.effective[1]).toEqual({
      world: 'watchlist',
      effective: 'read',
      note: 'not in proposers',
    });
    expect(saved.effective[2]).toMatchObject({
      world: 'ghost',
      note: expect.stringMatching(/^inert/),
    });

    const read = must(
      await call<{ mounts: Array<{ world: string; as?: string }> }>('mounts', {
        personalityId: 'engineer',
      }),
    );
    expect(read.mounts[1]).toEqual({ world: 'watchlist', mode: 'propose', as: 'stocks' });

    const collide = await call('mountsSave', {
      personalityId: 'engineer',
      mounts: [
        { world: 'acme', mode: 'read' },
        { world: 'watchlist', mode: 'read', as: 'acme' },
      ],
    });
    expect(collide.status).toBe(400);
    expect(collide.body.code).toBe('INPUT_INVALID');
    expect(collide.body.message).toContain('acme');
    expect((await call('mounts', { personalityId: 'nobody' })).status).toBe(404);
  });

  // ---- export, import, buildPreview, share, linkify -------------------------

  it('export then import round-trips facts-yaml into another world', async () => {
    await seedSchema();
    await seedSchema('world:watchlist');
    const ravi = await write('world:acme', { kind: 'entity', type: 'Person', name: 'Ravi' });
    const core = await write('world:acme', { kind: 'entity', type: 'Team', name: 'Core' });
    await write('world:acme', { kind: 'edge', type: 'member_of', fromId: ravi, toId: core });

    const exported = must(
      await call<{ filename: string; mime: string; text: string }>('export', {
        world: 'world:acme',
        format: 'facts-yaml',
      }),
    );
    expect(exported.filename).toBe('acme.facts.yaml');
    expect(exported.text).toContain('Ravi');
    for (const format of ['json', 'graphml', 'mermaid', 'mcp-jsonl', 'csv']) {
      const r = must(await call<{ text: string }>('export', { world: 'world:acme', format }));
      expect(r.text.length, format).toBeGreaterThan(0);
    }

    const imported = must(
      await call<{ entities: number; edges: number; skipped: unknown[] }>('import', {
        world: 'world:watchlist',
        format: 'facts-yaml',
        text: exported.text,
      }),
    );
    expect(imported).toMatchObject({ entities: 2, edges: 1, skipped: [] });
    const bundle = await runtime.service.ownerExport('world:watchlist');
    expect(bundle.entities.map((e) => e.name).sort()).toEqual(['Core', 'Ravi']);
    expect(bundle.entities.every((e) => e.author === 'import')).toBe(true);

    const bad = await call('import', {
      world: 'world:watchlist',
      format: 'facts-yaml',
      text: 'facts: [oops',
    });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('INPUT_INVALID');
  });

  it('buildPreview reads staged build items from the service store', async () => {
    await seedSchema();
    // A second handle on service.db (WAL): the staging a first build would have written.
    const store = new SQLiteWorldServiceStore(serviceDbPath(dataDir));
    const id = store.insertBuild({
      world: 'world:acme',
      personalityId: 'engineer',
      estimateUsd: 0.01,
      summary: {},
      watermark: null,
    });
    store.updateBuild(id, { status: 'staged' });
    store.replaceBuildItems(id, [
      {
        kind: 'fact',
        payload: { fact: 'entity', type: 'Person', name: 'Ravi', aliases: [] },
        sure: true,
        sourceRef: 'memory:MEMORY.md',
      },
      {
        kind: 'fact',
        payload: {
          fact: 'attribute',
          entity: { type: 'Person', name: 'Ravi' },
          key: 'title',
          value: 'SRE',
          confidence: 0.9,
        },
        sure: true,
        sourceRef: 'memory:MEMORY.md',
      },
      {
        kind: 'conflict',
        payload: {
          entity: { type: 'Person', name: 'Ravi' },
          key: 'title',
          value: 'CTO',
          confidence: 0.8,
          existing: { factId: 'a-1', value: 'SRE' },
        },
        sure: false,
        sourceRef: 'session:s1',
      },
    ]);
    const body = must(
      await call<{
        summary: Record<string, number>;
        items: Array<{ kind: string; conflict: boolean }>;
      }>('buildPreview', { world: 'world:acme', source: id }),
    );
    store.dispose();
    expect(body.summary).toEqual({ entities: 1, attributes: 2, edges: 0, proposals: 3 });
    expect(body.items.filter((i) => i.conflict)).toHaveLength(1);
    expect((await call('buildPreview', { world: 'world:acme', source: 'b-nope' })).status).toBe(
      404,
    );
  });

  it('shareCreate is refused 503 NOT_CONFIGURED until world snapshots land (7.6)', async () => {
    const res = await call('shareCreate', { world: 'world:acme', view: 'tree', expiresInDays: 7 });
    expect(res.status).toBe(503);
    expect(
      (await call('shareCreate', { world: 'world:ghost', view: 'tree', expiresInDays: 7 })).status,
    ).toBe(404);
  });

  it('linkify links names and aliases and the spans cover the text', async () => {
    await seedSchema();
    await write('world:acme', { kind: 'entity', type: 'Person', name: 'Ravi', aliases: ['Rav'] });
    const text = 'Met Ravi today; ask Rav about Raviolis.';
    const body = must(
      await call<{ spans: Array<{ text: string; entity?: { type: string } }> }>('linkify', {
        world: 'world:acme',
        text,
      }),
    );
    expect(body.spans.map((s) => s.text).join('')).toBe(text);
    expect(body.spans.filter((s) => s.entity).map((s) => s.text)).toEqual(['Ravi', 'Rav']);
  });
});
