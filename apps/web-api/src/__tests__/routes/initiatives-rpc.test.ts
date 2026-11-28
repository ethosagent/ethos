import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteSessionStore, SqliteApiKeyStore } from '@ethosagent/session-sqlite';
import { FsStorage } from '@ethosagent/storage-fs';
import type { PersonalityConfig } from '@ethosagent/types';
import { CONSTITUTION_INITIATIVES_KEYS } from '@ethosagent/types';
import {
  CONSTITUTION_INITIATIVES_FIELD_KEYS,
  flattenObjectKeys,
  INITIATIVE_FILE_FIELD_KEYS,
  INITIATIVE_SETTINGS_FIELD_KEYS,
} from '@ethosagent/web-contracts';
import {
  InitiativeFileSchema,
  InitiativeSettingsSchema,
  initiativesDbPath,
  SQLiteInitiativeStore,
} from '@ethosagent/wiring';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWebApi, WebTokenRepository } from '../../index';
import { SCOPE_MAP } from '../../middleware/dual-auth';
import {
  makeStubAgentLoop,
  makeStubMemoryBundle,
  makeStubPersonalityRegistry,
} from '../test-helpers';

// plan initiative-engine Task 6.2: the initiatives and constitution procedures are cookie-only
// (neither namespace is in SCOPE_MAP) and every write passes the CSRF middleware.

const SAME = { origin: 'http://localhost:3000', host: 'localhost:3000' };

const SETTINGS = {
  enabled: true,
  selfStart: false,
  dailyBudgetUsd: 3,
  standingGuidance: [],
};

const FULL_BLOCK = {
  enabled: true,
  maxUsdPerDay: null,
  maxUsdPerDayPerPersonality: null,
  selfStartPoolUsdPerDay: 0.5,
  maxSelfStarted: 2,
};

const CONSTITUTION_FIXTURE = `# operator ceiling
budget:
  maxUsdPerSession: 5   # keep this comment

forbidden:
  tools: [terminal]
  # trailing comment in forbidden
initiatives:
  enabled: true
  maxUsdPerDayPerPersonality: 4
`;

describe('initiatives RPC', () => {
  let dataDir: string;
  let sessions: SQLiteSessionStore;
  let apiKeys: SqliteApiKeyStore;
  let app: ReturnType<typeof createWebApi>['app'];
  let cookie: string;
  const reload = vi.fn(async (_id?: string) => {});

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'ethos-initiatives-rpc-'));
    sessions = new SQLiteSessionStore(':memory:');
    apiKeys = new SqliteApiKeyStore(':memory:');
    reload.mockClear();
    ({ app } = createWebApi({
      dataDir,
      sessionStore: sessions,
      memoryBundle: makeStubMemoryBundle(),
      agentLoop: makeStubAgentLoop(),
      personalities: makeStubPersonalityRegistry([{ id: 'pm', name: 'PM' } as PersonalityConfig]),
      chatDefaults: { model: 'claude-test', provider: 'anthropic' },
      apiKeys,
      initiativeEnablement: { reload },
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

  const call = (path: string, input: unknown, headers: Record<string, string>) =>
    app.request(`/rpc/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ json: input }),
    });
  const as = (): Record<string, string> => ({ cookie, ...SAME });
  const body = async (res: Response) => ((await res.json()) as { json: unknown }).json;

  /** Seed the ledger through the real store: one proposed and one briefed exploration, one self-started initiative. */
  function seed(): { proposed: string; briefed: string } {
    const store = new SQLiteInitiativeStore(initiativesDbPath(dataDir), {
      explorationCapFor: () => 5,
    });
    const row = (id: string, state: 'active' | 'self_started') => ({
      id,
      personalityId: 'pm',
      origin: 'human' as const,
      parentId: null,
      state,
      configPath: join(dataDir, 'personalities', 'pm', 'initiatives', `${id}.yaml`),
      configHash: 'h',
      version: 1,
    });
    store.upsertInitiative(row('grow', 'active'));
    store.upsertInitiative({ ...row('idea-x', 'self_started'), origin: 'agent' });
    const propose = (q: string) =>
      store.propose({ initiativeId: 'grow', ideaId: null, question: q, estimateUsd: 1, days: 7 });
    const proposed = propose('Which channel converts?');
    const briefed = propose('Is pricing the blocker?');
    store.transitionExploration(briefed.id, 'exploring', 'x');
    store.transitionExploration(briefed.id, 'briefed', 'x');
    store.close();
    return { proposed: proposed.id, briefed: briefed.id };
  }

  const PROCEDURES: Array<[string, unknown]> = [
    ['initiatives/list', {}],
    ['initiatives/settings', { personalityId: 'pm' }],
    ['initiatives/settingsSave', { personalityId: 'pm', settings: SETTINGS }],
    ['initiatives/decide', { target: 'EXP-0001', gate: 'gate1_explore', verdict: 'approve' }],
    ['constitution/initiatives', undefined],
    ['constitution/initiativesSave', { initiatives: FULL_BLOCK }],
  ];

  it('initiatives and constitution are not SCOPE_MAP namespaces', () => {
    expect(Object.keys(SCOPE_MAP)).not.toContain('initiatives');
    expect(Object.keys(SCOPE_MAP)).not.toContain('constitution');
  });

  it.each(PROCEDURES)('bearer key is refused on %s', async (path, input) => {
    for (const scopes of [['sessions:read'], ['personalities:read', 'sessions:read']]) {
      const { secret } = await apiKeys.create({ name: 'k', scopes });
      const res = await call(path, input, { authorization: `Bearer ${secret}`, ...SAME });
      expect(res.status).toBe(403);
    }
    expect(existsSync(join(dataDir, 'personalities', 'pm', 'initiatives', 'settings.yaml'))).toBe(
      false,
    );
    expect(existsSync(join(dataDir, 'constitution.yaml'))).toBe(false);
  });

  it.each(PROCEDURES)('missing CSRF is refused on %s', async (path, input) => {
    const noOrigin = await call(path, input, { cookie });
    expect(noOrigin.status).toBe(401);
    const cross = await call(path, input, {
      cookie,
      origin: 'http://localhost:5999',
      host: 'localhost:3000',
    });
    expect(cross.status).toBe(401);
    expect(existsSync(join(dataDir, 'constitution.yaml'))).toBe(false);
    expect(existsSync(join(dataDir, 'personalities', 'pm', 'initiatives', 'settings.yaml'))).toBe(
      false,
    );
  });

  it('missing settings file returns defaults', async () => {
    const res = await call('initiatives/settings', { personalityId: 'pm' }, as());
    expect(res.status).toBe(200);
    expect(await body(res)).toMatchObject({
      status: 'missing',
      settings: { enabled: true, selfStart: false, dailyBudgetUsd: 0, standingGuidance: [] },
      ceilings: {},
      guidance: [],
    });
  });

  it('reads with no ledger return empty results and never create initiatives.db', async () => {
    expect(await body(await call('initiatives/list', {}, as()))).toEqual({ items: [] });
    expect(await body(await call('initiatives/exploringNow', {}, as()))).toEqual({
      current: null,
    });
    expect(
      await body(await call('initiatives/metrics', { personalityId: 'pm' }, as())),
    ).toMatchObject({ gate1: { asked: 0 } });
    expect(await body(await call('initiatives/activity', { initiativeId: 'x' }, as()))).toEqual({
      windows: [],
    });
    expect(existsSync(initiativesDbPath(dataDir))).toBe(false);
  });

  it('settings save writes the file, maps guidance and reloads enablement when enabled changes', async () => {
    const save = (settings: Record<string, unknown>) =>
      call('initiatives/settingsSave', { personalityId: 'pm', settings }, as());
    const first = await save({ ...SETTINGS, standingGuidance: ['watch reddit for pricing'] });
    expect(first.status).toBe(200);
    // Unchanged enabled (default on -> on): no reload.
    expect(reload).not.toHaveBeenCalled();
    const file = join(dataDir, 'personalities', 'pm', 'initiatives', 'settings.yaml');
    expect(await readFile(file, 'utf8')).toContain('dailyBudgetUsd: 3');

    const read = (await body(
      await call('initiatives/settings', { personalityId: 'pm' }, as()),
    )) as { status: string; guidance: Array<{ text: string; status: string }> };
    expect(read.status).toBe('loaded');
    expect(read.guidance[0]?.status).toBe('unreachable'); // pm has no reddit tool

    const off = await save({ ...SETTINGS, enabled: false });
    expect(off.status).toBe(200);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledWith('pm');
  });

  it('settings save clamps dailyBudgetUsd to the operator ceiling', async () => {
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, 'constitution.yaml'), CONSTITUTION_FIXTURE);
    const res = await call(
      'initiatives/settingsSave',
      { personalityId: 'pm', settings: { ...SETTINGS, dailyBudgetUsd: 5 } },
      as(),
    );
    expect(await body(res)).toMatchObject({
      saved: { dailyBudgetUsd: 4 },
      clamps: ['dailyBudgetUsd 5 → 4 (operator ceiling)'],
    });
  });

  it('settings save for an unknown personality is not found and creates no directory', async () => {
    const res = await call(
      'initiatives/settingsSave',
      { personalityId: 'ghost', settings: SETTINGS },
      as(),
    );
    expect(res.status).toBe(404);
    expect(existsSync(join(dataDir, 'personalities', 'ghost'))).toBe(false);
  });

  it.each(['initiatives/settings', 'initiatives/settingsSave'])(
    '%s with an unsafe personality id is 400 INVALID_INPUT and creates nothing',
    async (path) => {
      for (const personalityId of ['../etc', 'a/b', 'Bad Id', '.hidden']) {
        const res = await call(path, { personalityId, settings: SETTINGS }, as());
        expect(res.status).toBe(400);
        const err = (await body(res)) as { code: string; status: number };
        expect(err.status).toBe(400);
        expect(err.code).toBe('INVALID_INPUT');
      }
      expect(existsSync(join(dataDir, 'personalities'))).toBe(false);
    },
  );

  it('constitution save with a partial body is 400 and writes nothing', async () => {
    const res = await call(
      'constitution/initiativesSave',
      { initiatives: { enabled: true } },
      as(),
    );
    expect(res.status).toBe(400);
    expect(existsSync(join(dataDir, 'constitution.yaml'))).toBe(false);
  });

  it('unknown key is 400', async () => {
    const settings = await call(
      'initiatives/settingsSave',
      { personalityId: 'pm', settings: { ...SETTINGS, allowWrites: true } },
      as(),
    );
    expect(settings.status).toBe(400);
    const constitution = await call(
      'constitution/initiativesSave',
      { initiatives: { ...FULL_BLOCK, allowWrites: true } },
      as(),
    );
    expect(constitution.status).toBe(400);
    expect(existsSync(join(dataDir, 'constitution.yaml'))).toBe(false);
  });

  it('readableRoots refuses ~/.ssh', async () => {
    for (const root of ['~/.ssh', '~/.ssh/keys', '~']) {
      const res = await call(
        'constitution/initiativesSave',
        { initiatives: { ...FULL_BLOCK, readableRoots: [root] } },
        as(),
      );
      expect(res.status).toBe(400);
    }
    expect(existsSync(join(dataDir, 'constitution.yaml'))).toBe(false);
  });

  it('constitution save keeps other blocks', async () => {
    const path = join(dataDir, 'constitution.yaml');
    await writeFile(path, CONSTITUTION_FIXTURE);
    const res = await call(
      'constitution/initiativesSave',
      {
        initiatives: { ...FULL_BLOCK, enabled: false, maxUsdPerDay: 10, readableRoots: ['~/code'] },
      },
      as(),
    );
    expect(res.status).toBe(200);
    const after = await readFile(path, 'utf8');
    const head = CONSTITUTION_FIXTURE.slice(0, CONSTITUTION_FIXTURE.indexOf('initiatives:'));
    expect(after.startsWith(head)).toBe(true); // every other block, comments and spacing, byte for byte
    expect(after).toContain('enabled: false');
    expect(after).toContain('maxUsdPerDay: 10');
    expect(after).not.toContain('maxUsdPerDayPerPersonality');
    expect(reload).toHaveBeenCalled(); // the kill switch is read through enablement too
    const read = await body(await call('constitution/initiatives', undefined, as()));
    expect(read).toEqual({
      initiatives: {
        enabled: false,
        maxUsdPerDay: 10,
        selfStartPoolUsdPerDay: 0.5,
        maxSelfStarted: 2,
        readableRoots: ['~/code'],
      },
    });
  });

  it('constitution save refuses a constitution that does not parse', async () => {
    const path = join(dataDir, 'constitution.yaml');
    await writeFile(path, 'budget: [unclosed\n');
    const res = await call('constitution/initiativesSave', { initiatives: FULL_BLOCK }, as());
    expect(res.status).toBe(400);
    expect(await readFile(path, 'utf8')).toBe('budget: [unclosed\n');
  });

  it('decide records decided_by', async () => {
    const { proposed, briefed } = seed();
    const approve = await call(
      'initiatives/decide',
      { target: proposed, gate: 'gate1_explore', verdict: 'approve' },
      as(),
    );
    expect(approve.status).toBe(200);
    expect(await body(approve)).toMatchObject({
      ok: true,
      exploration: { id: proposed, state: 'exploring' },
    });
    const adopt = await call(
      'initiatives/decide',
      { target: briefed, gate: 'gate2_adopt', verdict: 'adopt', option: 'B' },
      as(),
    );
    expect(adopt.status).toBe(200);
    const keep = await call(
      'initiatives/decide',
      { target: 'idea-x', gate: 'self_start', verdict: 'keep' },
      as(),
    );
    expect(await body(keep)).toMatchObject({ initiative: { id: 'idea-x', state: 'active' } });

    const store = new SQLiteInitiativeStore(initiativesDbPath(dataDir));
    const rows = store.decisionsSince('pm', '1970-01-01T00:00:00.000Z');
    store.close();
    expect(rows.map((r) => [r.verdict, r.decidedBy, r.option])).toEqual([
      ['approve', 'owner:web', null],
      ['adopt', 'owner:web', 'B'],
      ['keep', 'owner:web', null],
    ]);
  });

  it('decide on the wrong state is a 409 conflict and records nothing', async () => {
    const { proposed } = seed();
    const res = await call(
      'initiatives/decide',
      { target: proposed, gate: 'gate2_adopt', verdict: 'adopt' },
      as(),
    );
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toContain(`${proposed} is proposed, not briefed`);
    const store = new SQLiteInitiativeStore(initiativesDbPath(dataDir));
    expect(store.decisionsSince('pm', '1970-01-01T00:00:00.000Z')).toEqual([]);
    store.close();
  });

  it('Make it mine starts the setup in chat', async () => {
    seed();
    const res = await call(
      'initiatives/decide',
      { target: 'idea-x', gate: 'self_start', verdict: 'make_mine' },
      as(),
    );
    expect(res.status).toBe(200);
    const out = (await body(res)) as { chatLink?: string };
    expect(out.chatLink).toBe('/p/pm/chat?draft=make%20idea-x%20mine');
    // No config written, no decision recorded, state unchanged.
    expect(existsSync(join(dataDir, 'personalities', 'pm', 'initiatives'))).toBe(false);
    const store = new SQLiteInitiativeStore(initiativesDbPath(dataDir));
    expect(store.decisionsSince('pm', '1970-01-01T00:00:00.000Z')).toEqual([]);
    expect(store.getInitiative('idea-x')?.state).toBe('self_started');
    store.close();
  });

  it('lists seeded initiatives with open exploration counts', async () => {
    seed();
    const out = (await body(await call('initiatives/list', { personalityId: 'pm' }, as()))) as {
      items: Array<{ id: string; openExplorations: number; title: string | null }>;
    };
    expect(out.items.map((i) => i.id)).toEqual(['grow', 'idea-x']);
    expect(out.items[0]?.openExplorations).toBe(1); // the briefed one is awaiting Gate 2, not open
    expect(out.items[0]?.title).toBeNull(); // no file on disk: reported, not thrown
  });
});

// The web-contracts schemas duplicate the domain ones (web-contracts may not import extensions), so
// these pin every leaf key: a key added on one side fails here until the other follows.
describe('web-contracts key lists match the domain schemas', () => {
  it('settings keys', () => {
    expect([...INITIATIVE_SETTINGS_FIELD_KEYS].sort()).toEqual(
      flattenObjectKeys(InitiativeSettingsSchema).sort(),
    );
  });
  it('constitution initiatives keys', () => {
    expect([...CONSTITUTION_INITIATIVES_FIELD_KEYS].sort()).toEqual(
      [...CONSTITUTION_INITIATIVES_KEYS].sort(),
    );
  });
  it('initiative file keys', () => {
    expect([...INITIATIVE_FILE_FIELD_KEYS].sort()).toEqual(
      flattenObjectKeys(InitiativeFileSchema).sort(),
    );
  });
});
