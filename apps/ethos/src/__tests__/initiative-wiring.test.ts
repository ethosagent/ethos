import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InitiativeConfigService } from '@ethosagent/initiative-runner';
import { FsStorage } from '@ethosagent/storage-fs';
import {
  createInitiativeCliPort,
  initiativesDbPath,
  SQLiteInitiativeStore,
} from '@ethosagent/wiring';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createInitiativeTapHandler,
  type InitiativeTap,
  initiativePortFor,
  wireInitiativeAdapters,
} from '../lib/initiative-wiring';

const DRAFT = {
  id: 'grow',
  version: 1,
  origin: 'human',
  created_in: 'web',
  state: 'active',
  title: 'Grow signups',
  outcome: 'More trials',
  sources: ['web'],
  exclude: [],
  guidance: [],
  autonomy: { mode: 'ask' },
  budget: { usd_per_day: 2, usd_per_exploration: 1, max_open_explorations: 2 },
  timeline: {
    explore_windows: ['every 2h'],
    window_minutes: 20,
    default_days: 14,
    review_on: '2026-12-20',
  },
  delivery: { owner_channel: 'telegram:1', digest_time: '09:00' },
};

let dir: string;
const storage = new FsStorage();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ethos-initiative-wiring-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function seed() {
  const store = new SQLiteInitiativeStore(initiativesDbPath(dir), { explorationCapFor: () => 5 });
  const svc = new InitiativeConfigService({
    storage,
    dataDir: dir,
    store,
    constitution: async () => ({}),
    settings: async () => ({
      enabled: true,
      selfStart: false,
      dailyBudgetUsd: 0,
      standingGuidance: [],
    }),
    toolset: () => ['web_search'],
    schedule: () => {},
  });
  expect(
    await svc.save({
      personalityId: 'pm',
      op: 'create',
      draft: DRAFT,
      sessionId: 's',
      confirmedBy: 'owner_chat',
    }),
  ).toMatchObject({ ok: true });
  const mk = (q: string) =>
    store.propose({ initiativeId: 'grow', ideaId: null, question: q, estimateUsd: 1, days: 7 });
  const briefed = mk('Is pricing the blocker?');
  store.transitionExploration(briefed.id, 'exploring', 'x');
  store.transitionExploration(briefed.id, 'briefed', 'x');
  store.addFinding({
    explorationId: briefed.id,
    claim: 'Free users churn',
    sourceRef: 's',
    confidence: 0.8,
  });
  store.submitBrief({
    explorationId: briefed.id,
    bodyMd: '## Options\n- A\n- B',
    recommendedOption: 'A',
    partial: false,
  });
  const proposed = mk('Which channel converts?');
  store.close();
  return { briefed: briefed.id, proposed: proposed.id };
}

function tapFor(
  verb: InitiativeTap['verb'],
  target: string,
  userId: string | undefined,
  sendOk = true,
) {
  const said: string[] = [];
  const sent: string[] = [];
  const tap: InitiativeTap = {
    verb,
    target,
    userId,
    say: async (t) => void said.push(t),
    send: async (t) => {
      sent.push(t);
      return sendOk;
    },
  };
  return { tap, said, sent };
}

const handler = () =>
  createInitiativeTapHandler({
    port: initiativePortFor(storage, dir),
    ownerTarget: (p) => (p === 'telegram' ? '42' : undefined),
  });

const state = async (id: string) => {
  const p = await createInitiativeCliPort({ storage, dataDir: dir });
  try {
    return p?.store.getExploration(id)?.state;
  } finally {
    p?.close();
  }
};

describe('initiative buttons', () => {
  it('adopt button records gate2 adopt and closes the exploration', async () => {
    const { briefed } = await seed();
    const { tap, said } = tapFor('adopt', briefed, '42');
    await handler()('telegram', tap);
    expect(said).toEqual(['Adopted.']);
    expect(await state(briefed)).toBe('adopted');
    const db = new SQLiteInitiativeStore(initiativesDbPath(dir));
    const rows = db.decisionsSince('pm', '1970-01-01T00:00:00.000Z');
    db.close();
    expect(rows).toEqual([
      expect.objectContaining({
        target: briefed,
        gate: 'gate2_adopt',
        verdict: 'adopt',
        option: 'A',
        decidedBy: 'owner:telegram:42',
      }),
    ]);
  });

  it('non-owner tap refused', async () => {
    const { briefed, proposed } = await seed();
    for (const [verb, target, user] of [
      ['adopt', briefed, '99'],
      ['approve', proposed, undefined],
    ] as const) {
      const { tap, said } = tapFor(verb, target, user);
      await handler()('telegram', tap);
      expect(said).toEqual(['Only the owner can decide this.']);
    }
    // A platform with no configured owner refuses everyone.
    const { tap, said } = tapFor('adopt', briefed, '42');
    await handler()('slack', tap);
    expect(said).toEqual(['Only the owner can decide this.']);
    expect(await state(briefed)).toBe('briefed');
    expect(await state(proposed)).toBe('proposed');
  });

  it('a stale tap reports the conflict and writes nothing', async () => {
    const { proposed } = await seed();
    const { tap, said } = tapFor('adopt', proposed, '42');
    await handler()('telegram', tap);
    expect(said[0]).toContain('not briefed');
    expect(await state(proposed)).toBe('proposed');
  });

  it('copy as markdown sends the brief with finding ids; edit hands off to chat', async () => {
    const { briefed } = await seed();
    const copy = tapFor('copy_md', briefed, '42');
    await handler()('telegram', copy.tap);
    expect(copy.sent[0]).toContain('# Is pricing the blocker?');
    expect(copy.sent[0]).toMatch(/F-\d+: Free users churn/);
    const edit = tapFor('edit', briefed, '42');
    await handler()('telegram', edit.tap);
    expect(edit.said).toEqual(['Tell the agent in chat what to change.']);
    expect(await state(briefed)).toBe('briefed');
  });

  it('copy as markdown does not claim success when the send fails', async () => {
    const { briefed } = await seed();
    const copy = tapFor('copy_md', briefed, '42', false);
    await handler()('telegram', copy.tap);
    expect(copy.said.join(' ')).not.toContain('Sent as Markdown.');
    expect(copy.said[0]).toContain('ethos initiatives show');
  });

  it('wires only adapters that render initiative buttons, from their own id', async () => {
    const taps: string[] = [];
    let registered: ((e: never) => unknown) | undefined;
    const capable = {
      id: 'telegram:bot1',
      onInitiativeAction: (h: (e: never) => unknown) => {
        registered = h;
      },
    };
    const wired = wireInitiativeAdapters(
      async (platform) => void taps.push(platform),
      [capable, { id: 'discord' }],
    );
    expect(wired).toBe(1);
    await registered?.({
      verb: 'park',
      target: 'EXP-1',
      userId: '1',
      reply: async () => {},
    } as never);
    expect(taps).toEqual(['telegram']);
  });
});
