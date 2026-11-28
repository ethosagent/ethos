import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AgentLoop, DefaultHookRegistry } from '@ethosagent/core';
import { SQLiteDeliveryLedger } from '@ethosagent/delivery-ledger';
import { Gateway } from '@ethosagent/gateway';
import { InitiativeConfigService } from '@ethosagent/initiative-runner';
import { FsStorage } from '@ethosagent/storage-fs';
import {
  type DeliveryResult,
  type InitiativeActionVerb,
  type InitiativeDigest,
  initiativeActionId,
  type OutboundMessage,
  type PlatformAdapter,
  parseInitiativeAction,
} from '@ethosagent/types';
import {
  createInitiativeCliPort,
  initiativesDbPath,
  SQLiteInitiativeStore,
} from '@ethosagent/wiring';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDigestNotify,
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

const DIGEST = (explorationId: string): InitiativeDigest => ({
  personalityId: 'pm',
  generatedAt: '2026-11-28T08:00:00.000Z',
  since: '2026-11-27T08:00:00.000Z',
  ownWork: { windows: 0, spentUsd: 0, explorations: [] },
  needsYes: [{ explorationId, question: 'Which channel converts?', estimateUsd: 1 }],
  agentInitiatives: [],
  briefs: [],
  questions: [],
  suggestions: [],
});

describe('digest delivery', () => {
  it('forwards the digest and the owner channel to the tracked send, as the one bot there is', async () => {
    const calls: unknown[][] = [];
    const notify = createDigestNotify({
      listAdapters: () => [{ id: 'telegram:bot1' }, { id: 'telegram:bot1' }],
      notifyTrackedOutcome: async (...args) => {
        calls.push(args);
        return 'confirmed';
      },
    });
    const digest = DIGEST('EXP-0001');
    await expect(notify({ platform: 'telegram', chatId: '42' }, 'md', digest)).resolves.toBe(true);
    expect(calls).toEqual([
      [{ platform: 'telegram', chatId: '42', botKey: 'bot1' }, 'md', { initiativeDigest: digest }],
    ]);
  });

  it('refuses the send when more than one bot serves the owner platform', async () => {
    const notifyTracked = vi.fn(async () => 'confirmed' as const);
    const notify = createDigestNotify({
      listAdapters: () => [{ id: 'telegram:bot1' }, { id: 'telegram:bot2' }],
      notifyTrackedOutcome: notifyTracked,
    });
    await expect(
      notify({ platform: 'telegram', chatId: '42' }, 'md', DIGEST('EXP-0001')),
    ).resolves.toBe(false);
    expect(notifyTracked).not.toHaveBeenCalled();
  });

  it('a refused card is owed to the ledger: the sweep delivers it once and a later send is not needed', async () => {
    const ledger = new SQLiteDeliveryLedger(':memory:');
    const texts: string[] = [];
    let refuse = true;
    const adapter = {
      id: 'telegram:bot1',
      displayName: 'Telegram',
      capabilities: { platform: 'telegram' },
      canSendTyping: false,
      canEditMessage: false,
      canReact: false,
      canSendFiles: false,
      maxMessageLength: 4096,
      start: async () => {},
      stop: async () => {},
      onMessage: () => {},
      health: async () => ({ ok: true }),
      sendInitiativeDigest: async (): Promise<DeliveryResult> => ({
        ok: false,
        error: 'invalid_blocks',
      }),
      send: async (_c: string, m: OutboundMessage): Promise<DeliveryResult> => {
        if (refuse) return { ok: false, error: 'refused' };
        texts.push(m.text);
        return { ok: true };
      },
    };
    const gateway = new Gateway({
      bots: [
        {
          botKey: 'bot1',
          loop: {
            run: async function* () {
              yield { type: 'done' as const, text: '', turnCount: 1 };
            },
            hooks: new DefaultHookRegistry(),
          } as unknown as AgentLoop,
          binding: { type: 'personality' as const, name: 'default' },
        },
      ],
      deliveryLedger: ledger,
      adapters: new Map([['telegram', adapter as unknown as PlatformAdapter]]),
      clarifySweepIntervalMs: 0,
    });
    const notify = createDigestNotify(gateway);
    await expect(
      notify({ platform: 'telegram', chatId: '42' }, 'md', DIGEST('EXP-0001')),
    ).resolves.toBe('owed');
    refuse = false;
    await gateway.sweepPendingDeliveries();
    expect(texts).toEqual(['md']);
  });

  // A card-capable adapter as the gateway sees one: it renders the buttons from the digest (the
  // real `digestCard` / `digestBlocks` ids are pinned in the platform packages) and routes a tap
  // through `onInitiativeAction`, exactly as `wireInitiativeAdapters` expects.
  function cardAdapter() {
    const delivered: Array<{ chatId: string; buttons: string[]; text: string }> = [];
    const texts: OutboundMessage[] = [];
    let tapHandler: ((e: never) => unknown) | undefined;
    const adapter = {
      id: 'telegram:bot1',
      displayName: 'Telegram',
      capabilities: { platform: 'telegram' },
      canSendTyping: false,
      canEditMessage: false,
      canReact: false,
      canSendFiles: false,
      maxMessageLength: 4096,
      start: async () => {},
      stop: async () => {},
      onMessage: () => {},
      health: async () => ({ ok: true }),
      send: async (_c: string, m: OutboundMessage): Promise<DeliveryResult> => {
        texts.push(m);
        return { ok: true };
      },
      sendInitiativeDigest: async (
        chatId: string,
        d: InitiativeDigest,
        fallback: { text: string },
      ): Promise<DeliveryResult> => {
        const verbs: InitiativeActionVerb[] = ['approve', 'reject'];
        delivered.push({
          chatId,
          text: fallback.text,
          buttons: d.needsYes.flatMap((p) =>
            verbs.map((v) => initiativeActionId(v, p.explorationId)),
          ),
        });
        return { ok: true, messageId: '7' };
      },
      onInitiativeAction: (h: (e: never) => unknown) => {
        tapHandler = h;
      },
    };
    const tapAs = async (data: string, userId: string) => {
      const parsed = parseInitiativeAction(data);
      const answers: string[] = [];
      await tapHandler?.({
        ...parsed,
        userId,
        answer: async (t?: string) => void answers.push(t ?? ''),
        reply: async () => true,
      } as never);
      return answers;
    };
    return { adapter, delivered, texts, tapAs };
  }

  it('a delivered button runs the owner-only tap handler: owner records, non-owner is refused', async () => {
    const { proposed } = await seed();
    const fake = cardAdapter();
    const gateway = new Gateway({
      bots: [
        {
          botKey: 'bot1',
          loop: {
            run: async function* () {
              yield { type: 'done' as const, text: '', turnCount: 1 };
            },
            hooks: new DefaultHookRegistry(),
          } as unknown as AgentLoop,
          binding: { type: 'personality' as const, name: 'default' },
        },
      ],
      deliveryLedger: new SQLiteDeliveryLedger(':memory:'),
      adapters: new Map([['telegram', fake.adapter as unknown as PlatformAdapter]]),
      clarifySweepIntervalMs: 0,
    });
    const wired = wireInitiativeAdapters(handler(), [fake.adapter]);
    expect(wired).toBe(1);

    const notify = createDigestNotify(gateway);
    await expect(
      notify({ platform: 'telegram', chatId: '42' }, 'md fallback', DIGEST(proposed)),
    ).resolves.toBe(true);
    expect(fake.texts).toEqual([]);
    expect(fake.delivered).toHaveLength(1);
    expect(fake.delivered[0]?.text).toBe('md fallback');
    const [approve] = fake.delivered[0]?.buttons ?? [];
    expect(approve).toBe(`init:approve:${proposed}`);

    expect(await fake.tapAs(approve ?? '', '999')).toEqual(['Only the owner can decide this.']);
    expect(await state(proposed)).toBe('proposed');

    expect(await fake.tapAs(approve ?? '', '42')).toEqual(['Approved. It starts exploring.']);
    expect(await state(proposed)).not.toBe('proposed');
  });
});
