import { homedir } from 'node:os';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type {
  Constitution,
  InitiativeRow,
  InitiativeState,
  InitiativeStore,
} from '@ethosagent/types';
import { canTransition, INITIATIVE_TRANSITIONS } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { InitiativeConfigService } from '../index';

const HOME = homedir();
const DATA = '/data/.ethos';
const DIR = `${DATA}/personalities/pm/initiatives`;

type FakeStore = Pick<
  InitiativeStore,
  'upsertInitiative' | 'appendConfigVersion' | 'getInitiative' | 'list' | 'transitionInitiative'
> & {
  versions: Array<{
    initiativeId: string;
    version: number;
    sessionId: string | null;
    confirmedBy: string;
    diff: string;
  }>;
  rows: Map<string, InitiativeRow>;
};

function fakeStore(): FakeStore {
  const rows = new Map<string, InitiativeRow>();
  const versions: FakeStore['versions'] = [];
  return {
    rows,
    versions,
    upsertInitiative: (r) => void rows.set(r.id, r),
    appendConfigVersion: (v) => void versions.push(v),
    getInitiative: (id) => rows.get(id) ?? null,
    list: (f) =>
      [...rows.values()].filter(
        (r) => r.personalityId === f.personalityId && (!f.states || f.states.includes(r.state)),
      ),
    transitionInitiative: (id, to: InitiativeState) => {
      const r = rows.get(id);
      if (!r || !canTransition(INITIATIVE_TRANSITIONS, r.state, to)) throw new Error('illegal');
      rows.set(id, { ...r, state: to });
    },
  };
}

function draft(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'grow-signups',
    version: 1,
    origin: 'human',
    created_in: 'web',
    state: 'active',
    title: 'Grow signups',
    outcome: 'More trials',
    sources: [{ repo: `${HOME}/code/app` }, 'web'],
    exclude: [],
    guidance: [{ text: 'check g2.com reviews' }],
    autonomy: { mode: 'free_under', ask_above_usd: 1 },
    budget: { usd_per_day: 2, usd_per_exploration: 1, max_open_explorations: 2 },
    timeline: {
      explore_windows: ['every 2h'],
      window_minutes: 20,
      default_days: 14,
      review_on: '2026-12-20',
    },
    delivery: { owner_channel: 'telegram', digest_time: '09:00' },
    ...over,
  };
}

function setup(opts: { constitution?: Constitution; settings?: object; toolset?: string[] } = {}) {
  const storage = new InMemoryStorage();
  const store = fakeStore();
  const scheduled: string[] = [];
  const svc = new InitiativeConfigService({
    storage,
    dataDir: DATA,
    store,
    constitution: async () =>
      opts.constitution ?? { initiatives: { readableRoots: [`${HOME}/code`] } },
    settings: async () => ({
      enabled: true,
      selfStart: false,
      dailyBudgetUsd: 0,
      standingGuidance: [],
      ...opts.settings,
    }),
    toolset: () => opts.toolset ?? ['web_search', 'read_file'],
    schedule: (id) => void scheduled.push(id),
    now: () => 1_000,
  });
  return { storage, store, scheduled, svc };
}

const APP = { repo: `${HOME}/code/app` };
const ID = { id: 'grow-signups' };
const save = (
  svc: InitiativeConfigService,
  d: unknown,
  over: Partial<Parameters<InitiativeConfigService['save']>[0]> = {},
) =>
  svc.save({
    personalityId: 'pm',
    op: 'create',
    draft: d,
    sessionId: 's1',
    confirmedBy: 'owner_chat',
    ...over,
  });

describe('InitiativeConfigService.save', () => {
  it('fills nextSurveyAt with the next explore-window slot after now (injected clock)', async () => {
    const { svc } = setup();
    const r = await save(svc, draft());
    // now = 1s after the epoch; 'every 2h' slots sit on the UTC day's even hours.
    expect(r).toMatchObject({ ok: true, nextSurveyAt: '1970-01-01T02:00:00.000Z' });
    const paused = await save(svc, ID, { op: 'pause' });
    expect(paused).toMatchObject({ ok: true });
    expect(paused).not.toHaveProperty('nextSurveyAt');
  });

  it('creates the file, the row and the first version, then schedules', async () => {
    const { svc, storage, store, scheduled } = setup();
    const r = await save(svc, draft());
    expect(r).toMatchObject({ ok: true, id: 'grow-signups', version: 1, clamps: [] });
    expect(await storage.exists(`${DIR}/grow-signups.yaml`)).toBe(true);
    expect(store.rows.get('grow-signups')).toMatchObject({ personalityId: 'pm', version: 1 });
    expect(scheduled).toEqual(['grow-signups']);
  });

  it('R5 a path source outside readableRoots is refused with the reason, file untouched', async () => {
    const { svc, storage } = setup();
    for (const src of ['~/.ssh', '~/code/app/.env', '/etc', `${HOME}/other`]) {
      const r = await save(svc, draft({ sources: [{ repo: src }] }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain('source');
    }
    expect(await storage.exists(`${DIR}/grow-signups.yaml`)).toBe(false);
  });

  it('R5 a folder inside a root saves end to end', async () => {
    const { svc, storage } = setup();
    const r = await save(svc, draft({ sources: [{ repo: '~/code/app' }, 'web'] }));
    expect(r).toMatchObject({ ok: true });
    expect(await storage.read(`${DIR}/grow-signups.yaml`)).toContain('repo: ~/code/app');
  });

  it('R6 an agent draft that adds a source its parent lacks is refused', async () => {
    const { svc, storage } = setup({ settings: { selfStart: true } });
    await save(svc, draft({ sources: [APP] }));
    const child = draft({
      id: 'child',
      origin: 'agent',
      state: 'self_started',
      parent_id: 'grow-signups',
      sources: [APP, 'web'],
    });
    const r = await save(svc, child, { confirmedBy: 'runner' });
    expect(r).toEqual({ ok: false, error: expect.stringContaining('"web"') });
    expect(await storage.exists(`${DIR}/child.yaml`)).toBe(false);
    const ok = await save(svc, { ...child, sources: [APP] }, { confirmedBy: 'runner' });
    expect(ok.ok).toBe(true);
  });

  it('refuses agent origin when selfStart is off, the pool is full, or the caller is not the runner', async () => {
    const off = setup();
    const child = draft({ id: 'c1', origin: 'agent', state: 'self_started', parent_id: 'p' });
    expect(await save(off.svc, child, { confirmedBy: 'runner' })).toEqual({
      ok: false,
      error: expect.stringContaining('selfStart'),
    });
    const full = setup({
      settings: { selfStart: true },
      constitution: { initiatives: { readableRoots: [`${HOME}/code`], maxSelfStarted: 1 } },
    });
    await save(full.svc, draft({ id: 'p', sources: [APP] }));
    const a = draft({
      id: 'a',
      origin: 'agent',
      state: 'self_started',
      parent_id: 'p',
      sources: [APP],
    });
    expect((await save(full.svc, a, { confirmedBy: 'runner' })).ok).toBe(true);
    const b = { ...a, id: 'b' };
    expect(await save(full.svc, b, { confirmedBy: 'runner' })).toEqual({
      ok: false,
      error: expect.stringContaining('pool'),
    });
    expect((await save(full.svc, { ...a, id: 'z' }, { confirmedBy: 'owner_chat' })).ok).toBe(false);
  });

  it('clamp is reported', async () => {
    const { svc, storage } = setup({
      constitution: {
        initiatives: { readableRoots: [`${HOME}/code`], maxUsdPerDayPerPersonality: 4 },
      },
    });
    const r = await save(
      svc,
      draft({ budget: { usd_per_day: 5, usd_per_exploration: 1, max_open_explorations: 2 } }),
    );
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.clamps.join(' ')).toContain('usd_per_day');
    const text = await storage.read(`${DIR}/grow-signups.yaml`);
    expect(text).toContain('usd_per_day: 4');
  });

  it('every save is a new version with its session', async () => {
    const { svc, store } = setup();
    await save(svc, draft(), { sessionId: 's1' });
    const r2 = await save(svc, draft({ title: 'Grow trials' }), { op: 'update', sessionId: 's2' });
    expect(r2).toMatchObject({ ok: true, version: 2 });
    expect(store.versions.map((v) => [v.version, v.sessionId, v.confirmedBy])).toEqual([
      [1, 's1', 'owner_chat'],
      [2, 's2', 'owner_chat'],
    ]);
    expect(store.versions[1]?.diff).toContain('Grow trials');
  });

  it('undo restores the previous version', async () => {
    const { svc, storage } = setup();
    await save(svc, draft());
    const v1 = await storage.read(`${DIR}/grow-signups.yaml`);
    await save(svc, draft({ title: 'Changed' }), { op: 'update' });
    const r = await save(svc, draft(), { op: 'update' });
    expect(r).toMatchObject({ ok: true, version: 3 });
    const now = await storage.read(`${DIR}/grow-signups.yaml`);
    expect(now?.replace('version: 3', 'version: 1')).toBe(v1);
  });

  it('unknown key from the model is refused, file untouched', async () => {
    const { svc, storage } = setup();
    await save(svc, draft());
    const before = await storage.read(`${DIR}/grow-signups.yaml`);
    const r = await save(svc, draft({ allowWrites: true }), { op: 'update' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('allowWrites');
    expect(await storage.read(`${DIR}/grow-signups.yaml`)).toBe(before);
  });

  it('writes only under personalities/<id>/initiatives/', async () => {
    const { svc, storage } = setup();
    for (const id of ['../../evil', 'a/b', '..', 'settings']) {
      const r = await save(svc, draft({ id }));
      expect(r.ok).toBe(false);
    }
    const r = await save(svc, draft(), { personalityId: '../x' });
    expect(r.ok).toBe(false);
    expect(await storage.list(DATA)).toEqual([]);
  });

  it('refuses refused guidance (R8) and maps repo guidance only when a repo source covers it', async () => {
    const { svc, storage } = setup();
    const bad = await save(svc, draft({ guidance: [{ text: 'post in #general' }] }));
    expect(bad).toEqual({ ok: false, error: expect.stringContaining('post in #general') });
    const r = await save(svc, draft({ sources: ['web'], guidance: [{ text: 'read our repo' }] }));
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.guidance[0]?.status).toBe('unreachable');
    expect(await storage.read(`${DIR}/grow-signups.yaml`)).toContain('status: unreachable');
  });

  it('O-2 the runner cannot change budget, sources or autonomy of an existing initiative', async () => {
    const { svc } = setup({ settings: { selfStart: true } });
    await save(svc, draft({ origin: 'human' }));
    const r = await save(
      svc,
      draft({ budget: { usd_per_day: 3, usd_per_exploration: 1, max_open_explorations: 2 } }),
      { op: 'update', confirmedBy: 'runner' },
    );
    expect(r.ok).toBe(false);
  });

  it('pause after stop is refused cleanly (the ledger row, not the file, decides)', async () => {
    const { svc, store } = setup();
    await save(svc, draft());
    const row = store.rows.get('grow-signups');
    if (row) store.rows.set('grow-signups', { ...row, state: 'stopped' });
    expect(await save(svc, ID, { op: 'pause' })).toMatchObject({ ok: false });
  });

  it('pause, resume and end move state with a new version; bad moves are refused', async () => {
    const { svc, storage, store } = setup();
    await save(svc, draft());
    expect(await save(svc, ID, { op: 'pause' })).toMatchObject({ ok: true, version: 2 });
    expect(store.rows.get('grow-signups')?.state).toBe('paused');
    expect(await storage.read(`${DIR}/grow-signups.yaml`)).toContain('state: paused');
    expect(await save(svc, ID, { op: 'end' })).toMatchObject({ ok: false });
    expect(await save(svc, ID, { op: 'resume' })).toMatchObject({ ok: true, version: 3 });
    expect(await save(svc, ID, { op: 'pause' })).toMatchObject({ ok: true });
  });

  it('create refuses an existing id; update refuses a missing one', async () => {
    const { svc } = setup();
    expect((await save(svc, draft(), { op: 'update' })).ok).toBe(false);
    await save(svc, draft());
    expect((await save(svc, draft())).ok).toBe(false);
  });
});

function child(over: Record<string, unknown> = {}) {
  return draft({
    id: 'child',
    origin: 'agent',
    state: 'self_started',
    parent_id: 'grow-signups',
    sources: [APP],
    budget: { usd_per_day: 0.4, usd_per_exploration: 0.5, max_open_explorations: 1 },
    ...over,
  });
}

describe('R6 an agent draft may only narrow its parent', () => {
  const parentOver = {
    exclude: ['enterprise'],
    autonomy: { mode: 'free_under', ask_above_usd: 1 },
    sources: [APP, 'web'],
  };
  async function withParent() {
    const t = setup({ settings: { selfStart: true } });
    await save(t.svc, draft(parentOver));
    return t;
  }
  const asRunner = { confirmedBy: 'runner' as const };

  it('accepts a child that is equal or tighter', async () => {
    const { svc } = await withParent();
    const r = await save(
      svc,
      child({ exclude: ['enterprise', 'x'], autonomy: { mode: 'ask' } }),
      asRunner,
    );
    expect(r).toMatchObject({ ok: true });
  });

  it.each([
    ['a dropped exclude', { exclude: [] }, 'exclude'],
    ['looser autonomy mode', { autonomy: { mode: 'free' }, exclude: ['enterprise'] }, 'autonomy'],
    [
      'a higher ask_above_usd',
      { autonomy: { mode: 'free_under', ask_above_usd: 5 }, exclude: ['enterprise'] },
      'ask_above_usd',
    ],
    [
      'usd_per_exploration above the parent',
      {
        exclude: ['enterprise'],
        budget: { usd_per_day: 0.4, usd_per_exploration: 3, max_open_explorations: 1 },
      },
      'usd_per_exploration',
    ],
    [
      'max_open_explorations above the parent',
      {
        exclude: ['enterprise'],
        budget: { usd_per_day: 0.4, usd_per_exploration: 1, max_open_explorations: 9 },
      },
      'max_open_explorations',
    ],
  ])('refuses %s', async (_n, over, word) => {
    const { svc, storage } = await withParent();
    const r = await save(svc, child({ autonomy: { mode: 'ask' }, ...over }), asRunner);
    expect(r).toEqual({ ok: false, error: expect.stringContaining(word) });
    expect(await storage.exists(`${DIR}/child.yaml`)).toBe(false);
  });

  it('clamps usd_per_day to the self-start pool (default 0.50) and reports it', async () => {
    const { svc, storage } = await withParent();
    await save(
      svc,
      draft({
        ...parentOver,
        id: 'rich',
        budget: { usd_per_day: 9, usd_per_exploration: 1, max_open_explorations: 2 },
      }),
    );
    const r = await save(
      svc,
      child({
        parent_id: 'rich',
        exclude: ['enterprise'],
        autonomy: { mode: 'ask' },
        budget: { usd_per_day: 2, usd_per_exploration: 1, max_open_explorations: 1 },
      }),
      asRunner,
    );
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.clamps.join(' ')).toContain('self-start pool');
    expect(await storage.read(`${DIR}/child.yaml`)).toContain('usd_per_day: 0.5');
  });

  it('honours constitution selfStartPoolUsdPerDay', async () => {
    const t = setup({
      settings: { selfStart: true },
      constitution: {
        initiatives: { readableRoots: [`${HOME}/code`], selfStartPoolUsdPerDay: 0.1 },
      },
    });
    await save(t.svc, draft(parentOver));
    const r = await save(
      t.svc,
      child({ exclude: ['enterprise'], autonomy: { mode: 'ask' } }),
      asRunner,
    );
    expect(r).toMatchObject({ ok: true });
    expect(await t.storage.read(`${DIR}/child.yaml`)).toContain('usd_per_day: 0.1');
  });
});

describe('update guards', () => {
  it('refuses an update that changes origin', async () => {
    const { svc } = setup({ settings: { selfStart: true } });
    await save(svc, draft());
    await save(svc, child({ exclude: [], autonomy: { mode: 'ask' } }), { confirmedBy: 'runner' });
    const r = await save(svc, draft({ id: 'child' }), { op: 'update', confirmedBy: 'owner_chat' });
    expect(r).toEqual({ ok: false, error: expect.stringContaining('origin') });
    const back = await save(svc, child({ exclude: [], autonomy: { mode: 'ask' } }), {
      op: 'update',
      confirmedBy: 'runner',
    });
    expect(back.ok).toBe(true);
  });

  it('O-4 an owner update replaces a file that fails to parse; the runner may not', async () => {
    const { svc, storage } = setup();
    await save(svc, draft());
    await storage.writeAtomic(`${DIR}/grow-signups.yaml`, 'id: [unclosed\n  : :');
    const runner = await save(svc, draft(), { op: 'update', confirmedBy: 'runner' });
    expect(runner.ok).toBe(false);
    expect(await storage.read(`${DIR}/grow-signups.yaml`)).toContain('unclosed');
    const create = await save(svc, draft(), { op: 'create' });
    expect(create.ok).toBe(false);
    const owner = await save(svc, draft({ title: 'Fixed' }), { op: 'update' });
    expect(owner).toMatchObject({ ok: true, version: 2 });
    expect(await storage.read(`${DIR}/grow-signups.yaml`)).toContain('title: Fixed');
  });
});

describe('InitiativeConfigService.load', () => {
  it('an invalid hand edit pauses that initiative with the reason', async () => {
    const { svc, storage, store } = setup();
    await save(svc, draft());
    await storage.writeAtomic(`${DIR}/grow-signups.yaml`, stringify({ ...draft(), tools: ['x'] }));
    const out = await svc.load('pm');
    expect(out).toEqual([
      { id: 'grow-signups', ok: false, error: expect.stringContaining('tools') },
    ]);
    expect(store.rows.get('grow-signups')?.state).toBe('paused');
  });

  it('valid files load ok and settings.yaml is skipped', async () => {
    const { svc, storage } = setup();
    await save(svc, draft());
    await storage.writeAtomic(`${DIR}/settings.yaml`, 'enabled: true\n');
    expect(await svc.load('pm')).toEqual([{ id: 'grow-signups', ok: true }]);
  });
});
