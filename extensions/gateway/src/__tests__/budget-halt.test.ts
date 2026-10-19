import type { AgentLoop } from '@ethosagent/core';
import { BackgroundBudgetSkipped, DefaultHookRegistry, MeteredProvider } from '@ethosagent/core';
import type {
  AgentEvent,
  DeliveryResult,
  InboundMessage,
  LLMProvider,
  PlatformAdapter,
  UsageMeterEvent,
  UsageSourceKind,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { type BotSpend, Gateway } from '../index';

// Plan openclaw-2026.9.6-gaps S4/U1 — a budget `halt` reaches the lane as one
// message naming the cap and the reset command.

const CAP_MESSAGE = 'Stopped: hit $1.00 budget cap for this session ($1.0100 spent)';

function makeLoop(events: AgentEvent[]): AgentLoop & { runs: number; drained: boolean } {
  const state = { runs: 0, drained: false };
  return Object.assign(state, {
    hooks: new DefaultHookRegistry(),
    async *run() {
      state.runs++;
      for (const e of events) yield e;
      // The turn-end tail runs after `done`: rendering the halt must not
      // break out of the iterator before this line.
      state.drained = true;
    },
  }) as unknown as AgentLoop & { runs: number; drained: boolean };
}

function makeAdapter(): PlatformAdapter & { sent: string[] } {
  const sent: string[] = [];
  return {
    id: 'telegram:bot-1',
    displayName: 'Telegram',
    capabilities: { platform: 'test' },
    canSendTyping: false,
    canEditMessage: false,
    canReact: false,
    canSendFiles: false,
    maxMessageLength: 4096,
    async start() {},
    async stop() {},
    async send(_chatId: string, msg: { text: string }): Promise<DeliveryResult> {
      sent.push(msg.text);
      return { ok: true, messageId: `m${sent.length}` };
    },
    onMessage() {},
    async health() {
      return { ok: true };
    },
    sent,
  };
}

function inbound(text: string, overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform: 'telegram',
    botKey: 'bot-1',
    chatId: 'C1',
    userId: 'u1',
    text,
    isDm: true,
    isGroupMention: false,
    messageId: `msg-${Math.random()}`,
    raw: null,
    ...overrides,
  };
}

function gatewayFor(loop: AgentLoop): Gateway {
  return new Gateway({
    bots: [{ botKey: 'bot-1', loop, binding: { type: 'personality', name: 'researcher' } }],
    clarifySweepIntervalMs: 0,
  });
}

const costHalt: AgentEvent[] = [
  { type: 'text_delta', text: 'Partial answer' },
  { type: 'tool_progress', toolName: '_budget', message: CAP_MESSAGE, audience: 'user' },
  { type: 'halt', kind: 'budget', rule: 'cost-cap', toolName: '_budget', message: CAP_MESSAGE },
  { type: 'done', text: 'Partial answer', turnCount: 1 },
];

describe('gateway budget halt render (S4/U1)', () => {
  it('a cost-cap halt produces exactly one send carrying the cap and /budget reset', async () => {
    const loop = makeLoop(costHalt);
    const adapter = makeAdapter();
    await gatewayFor(loop).handleMessage(inbound('hi'), adapter);

    const withCap = adapter.sent.filter((t) => t.includes('$1.00 budget cap'));
    expect(withCap).toHaveLength(1);
    expect(withCap[0]).toContain('/budget reset');
    // The answer and the notice are one lane message, not two.
    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0]).toContain('Partial answer');
    expect(loop.drained).toBe(true);
  });

  it('a halt with no answer text still reaches the lane', async () => {
    const loop = makeLoop([
      { type: 'halt', kind: 'budget', rule: 'cost-cap', toolName: '_budget', message: CAP_MESSAGE },
      { type: 'done', text: '', turnCount: 1 },
    ]);
    const adapter = makeAdapter();
    await gatewayFor(loop).handleMessage(inbound('hi'), adapter);
    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0]).toContain('$1.00 budget cap');
  });

  it('a per-turn budget halt names the cap without the session reset command', async () => {
    const message = 'Stopped: hit 50-tool-call budget for this turn';
    const loop = makeLoop([
      { type: 'halt', kind: 'budget', rule: 'tool-budget', toolName: '_budget', message },
      { type: 'done', text: '', turnCount: 1 },
    ]);
    const adapter = makeAdapter();
    await gatewayFor(loop).handleMessage(inbound('hi'), adapter);
    expect(adapter.sent).toEqual([expect.stringContaining('50-tool-call budget')]);
    expect(adapter.sent[0]).not.toContain('/budget reset');
  });

  it('a watcher halt adds no notice — its pause already ends with a reply', async () => {
    const loop = makeLoop([
      { type: 'halt', kind: 'watcher', rule: 'loop', message: 'paused' },
      { type: 'text_delta', text: 'I paused because…' },
      { type: 'done', text: 'I paused because…', turnCount: 1 },
    ]);
    const adapter = makeAdapter();
    await gatewayFor(loop).handleMessage(inbound('hi'), adapter);
    expect(adapter.sent).toEqual(['I paused because…']);
  });
});

/** A loop with the session-cost surface `/budget` reads and resets. */
function makeCostLoop(cap: number | undefined): AgentLoop & {
  runs: number;
  costs: Map<string, number>;
} {
  const costs = new Map<string, number>();
  return Object.assign(makeLoop([{ type: 'done', text: 'ok', turnCount: 1 }]), {
    costs,
    getSessionCost: (key: string) => costs.get(key) ?? 0,
    resetSessionCost: (key: string) => {
      costs.delete(key);
    },
    getPersonalityBudgetCap: () => cap,
  }) as unknown as AgentLoop & { runs: number; costs: Map<string, number> };
}

describe('gateway /budget (S4/U1)', () => {
  // The lane's session key before any /new: `buildLaneKey(platform, botKey, chatId)`.
  const DM_LANE = 'telegram:bot-1:C1';

  it('/budget shows the session spend against the cap', async () => {
    const loop = makeCostLoop(1);
    loop.costs.set(DM_LANE, 0.25);
    const adapter = makeAdapter();
    await gatewayFor(loop).handleMessage(inbound('/budget'), adapter);
    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0]).toContain('$0.2500');
    expect(adapter.sent[0]).toContain('$1.00');
    expect(adapter.sent[0]).toContain('/budget reset');
    expect(loop.runs).toBe(0);
  });

  it('/budget reset on a DM lane clears the session cap', async () => {
    const loop = makeCostLoop(1);
    loop.costs.set(DM_LANE, 1.5);
    const adapter = makeAdapter();
    await gatewayFor(loop).handleMessage(inbound('/budget reset'), adapter);
    expect(loop.costs.has(DM_LANE)).toBe(false);
    expect(adapter.sent[0]).toMatch(/reset/i);
    expect(loop.runs).toBe(0);
  });

  it('a non-owner cannot reset a group budget; the owner can', async () => {
    const loop = makeCostLoop(1);
    const groupLane = 'telegram:bot-1:G1';
    loop.costs.set(groupLane, 1.5);
    const adapter = makeAdapter();
    const gateway = new Gateway({
      bots: [{ botKey: 'bot-1', loop, binding: { type: 'personality', name: 'researcher' } }],
      clarifySweepIntervalMs: 0,
      channelFilter: { telegram: { ownerUserId: 'owner', recipientAllowlist: ['member'] } },
    });
    const group = { chatId: 'G1', isDm: false, isGroupMention: true };

    await gateway.handleMessage(inbound('/budget reset', { ...group, userId: 'member' }), adapter);
    expect(loop.costs.get(groupLane)).toBe(1.5);
    expect(adapter.sent.at(-1)).toBe('Only the bot owner can reset the budget in a group.');

    await gateway.handleMessage(inbound('/budget reset', { ...group, userId: 'owner' }), adapter);
    expect(loop.costs.has(groupLane)).toBe(false);
  });

  it('a group with no owner configured refuses the reset and names the key', async () => {
    const loop = makeCostLoop(1);
    loop.costs.set('telegram:bot-1:G1', 1.5);
    const adapter = makeAdapter();
    await gatewayFor(loop).handleMessage(
      inbound('/budget reset', { chatId: 'G1', isDm: false, isGroupMention: true }),
      adapter,
    );
    expect(loop.costs.get('telegram:bot-1:G1')).toBe(1.5);
    expect(adapter.sent.at(-1)).toContain('channel_filter.telegram.ownerUserId');
  });
});

/** A spend figure that is all reply spend — the shape every D5 case used. */
const turnSpend = (usd: number): BotSpend => ({ repliesUsd: usd, backgroundUsd: 0 });

describe('gateway per-bot daily cap (D5)', () => {
  function cappedGateway(
    loop: AgentLoop,
    spend: () => Promise<number | BotSpend>,
    dailyBudgetUsd: number | null = 1,
  ): { gateway: Gateway; queries: Array<{ prefix: string; botKey: string; since: Date }> } {
    const queries: Array<{ prefix: string; botKey: string; since: Date }> = [];
    const gateway = new Gateway({
      bots: [
        {
          botKey: 'bot-1',
          loop,
          binding: { type: 'personality', name: 'researcher' },
          ...(dailyBudgetUsd !== null ? { budget: { dailyUsd: dailyBudgetUsd } } : {}),
        },
      ],
      clarifySweepIntervalMs: 0,
      botSpendSince: async (scope, since) => {
        queries.push({ prefix: scope.sessionKeyPrefix, botKey: scope.botKey, since });
        const got = await spend();
        return typeof got === 'number' ? turnSpend(got) : got;
      },
    });
    return { gateway, queries };
  }

  it('refuses the turn with one lane message once today’s spend meets the cap', async () => {
    const loop = makeLoop([{ type: 'done', text: 'answer', turnCount: 1 }]);
    const adapter = makeAdapter();
    const { gateway, queries } = cappedGateway(loop, async () => 1);
    await gateway.handleMessage(inbound('hi'), adapter);

    expect(loop.runs).toBe(0);
    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0]).toContain('daily budget');
    expect(adapter.sent[0]).toContain('$1.00');
    // One bot's sessions, since 00:00 UTC today.
    expect(queries[0]?.prefix).toBe('telegram:bot-1:');
    expect(queries[0]?.botKey).toBe('bot-1');
    expect(queries[0]?.since.toISOString()).toBe(
      `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`,
    );
  });

  it('runs the turn under the cap', async () => {
    const loop = makeLoop([{ type: 'done', text: 'answer', turnCount: 1 }]);
    const adapter = makeAdapter();
    const { gateway } = cappedGateway(loop, async () => 0.5);
    await gateway.handleMessage(inbound('hi'), adapter);
    expect(loop.runs).toBe(1);
    expect(adapter.sent).toEqual(['answer']);
  });

  it('reads the store once per window and adds live usage in between', async () => {
    const loop = makeLoop([
      { type: 'usage', inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0.2 },
      { type: 'done', text: 'answer', turnCount: 1 },
    ]);
    const adapter = makeAdapter();
    const { gateway, queries } = cappedGateway(loop, async () => 0.9);
    await gateway.handleMessage(inbound('first'), adapter);
    await gateway.handleMessage(inbound('second'), adapter);

    // 0.9 read + 0.2 from the first turn's usage event ≥ 1.00: refused, with
    // no second query against the store.
    expect(queries).toHaveLength(1);
    expect(loop.runs).toBe(1);
    expect(adapter.sent.at(-1)).toContain('daily budget');
  });

  it('is off without a configured cap — the store is never read', async () => {
    const loop = makeLoop([{ type: 'done', text: 'answer', turnCount: 1 }]);
    const adapter = makeAdapter();
    const { gateway, queries } = cappedGateway(loop, async () => 100, null);
    await gateway.handleMessage(inbound('hi'), adapter);
    expect(queries).toHaveLength(0);
    expect(loop.runs).toBe(1);
  });

  it('fails open when the spend cannot be read', async () => {
    const loop = makeLoop([{ type: 'done', text: 'answer', turnCount: 1 }]);
    const adapter = makeAdapter();
    const { gateway } = cappedGateway(loop, async () => {
      throw new Error('sessions.db locked');
    });
    await gateway.handleMessage(inbound('hi'), adapter);
    expect(loop.runs).toBe(1);
  });

  it('/budget shows today’s spend against the daily cap', async () => {
    const loop = makeCostLoop(undefined);
    const adapter = makeAdapter();
    const { gateway } = cappedGateway(loop, async () => 0.25);
    await gateway.handleMessage(inbound('/budget'), adapter);
    expect(adapter.sent[0]).toContain('$0.2500 of a $1.00 daily cap');
  });
});

// Background spend has its own gate, and counts against replies only with
// `backgroundBlocksReplies: true` (plan background-usage-accounting D14).
describe('gateway daily cap: background spend', () => {
  function capped(
    spend: () => Promise<BotSpend>,
    extra: { backgroundBlocksReplies?: boolean } = {},
  ) {
    const loop = makeCostLoop(undefined);
    const adapter = makeAdapter();
    const blocks: Array<{ code?: string; cause?: string; details?: Record<string, unknown> }> = [];
    const gateway = new Gateway({
      bots: [
        {
          botKey: 'bot-1',
          loop,
          binding: { type: 'personality', name: 'researcher' },
          budget: { dailyUsd: 1, ...extra },
        },
      ],
      // The bot's own adapter is how a background call with no platform in its
      // attribution (a memory-capture job) finds the bot's lanes.
      botAdapters: new Map([['bot-1', adapter]]),
      clarifySweepIntervalMs: 0,
      observability: {
        recordSafetyBlock: (b: { code?: string; details?: Record<string, unknown> }) => {
          blocks.push(b);
        },
      } as never,
      botSpendSince: async () => spend(),
    });
    return { gateway, loop, adapter, blocks };
  }

  /** A background provider metered the way wiring meters `captureLlm`, gated by the gateway. */
  function backgroundCall(gateway: Gateway, kind: UsageSourceKind = 'memory_capture') {
    const events: UsageMeterEvent[] = [];
    let innerCalls = 0;
    const inner = {
      name: 'fake',
      model: 'm',
      maxContextTokens: 1000,
      supportsCaching: false,
      supportsThinking: false,
      async *complete() {
        innerCalls++;
        yield { type: 'done' as const, finishReason: 'end_turn' };
      },
      async countTokens() {
        return 0;
      },
    } as unknown as LLMProvider;
    const provider = new MeteredProvider({
      inner,
      recorder: { record() {} },
      kind,
      attribution: { botKey: 'bot-1', personalityId: 'researcher' },
      gate: (req) => gateway.backgroundGate(req),
      onEvent: (e) => events.push(e),
    });
    const run = async () => {
      for await (const _ of provider.complete([], [], {})) {
        // drain
      }
    };
    return { run, events, innerCalls: () => innerCalls };
  }

  it('(1) background spend alone at the cap: replies run, background calls are skipped', async () => {
    const { gateway, loop, adapter } = capped(async () => ({ repliesUsd: 0, backgroundUsd: 1 }));
    await gateway.handleMessage(inbound('hi'), adapter);
    expect(loop.runs).toBe(1);
    expect(adapter.sent).toEqual(['ok']);

    expect(
      await gateway.backgroundGate({ kind: 'memory_capture', attribution: { botKey: 'bot-1' } }),
    ).toEqual({ decision: 'skip', spentUsd: 1, capUsd: 1 });

    const call = backgroundCall(gateway);
    await expect(call.run()).rejects.toBeInstanceOf(BackgroundBudgetSkipped);
    expect(call.innerCalls()).toBe(0);
    expect(call.events).toHaveLength(1);
    expect(call.events[0]).toMatchObject({
      type: 'usage.background_skipped',
      kind: 'memory_capture',
      spentUsd: 1,
      capUsd: 1,
    });
  });

  it('background calls run while the bot has money left', async () => {
    const { gateway } = capped(async () => ({ repliesUsd: 0.5, backgroundUsd: 0.4 }));
    const call = backgroundCall(gateway);
    await call.run();
    expect(call.innerCalls()).toBe(1);
    expect(call.events).toEqual([]);
  });

  it('never skips the goal judge — a skipped judge re-runs the goal attempt instead', async () => {
    const { gateway } = capped(async () => ({ repliesUsd: 0, backgroundUsd: 5 }));
    // The gate itself would skip; `GATE_EXEMPT_KINDS` keeps the meter from asking (D38).
    const call = backgroundCall(gateway, 'goal_judge');
    await call.run();
    expect(call.innerCalls()).toBe(1);
    expect(call.events).toEqual([]);
  });

  it('single-bot: a call naming no platform finds the bot through the sole platform adapter', async () => {
    const gateway = new Gateway({
      bots: [
        {
          botKey: 'bot-1',
          loop: makeLoop([]),
          binding: { type: 'personality', name: 'r' },
          budget: { dailyUsd: 1 },
        },
      ],
      // Filed under its platform, not the bot's key — the `adapterForBot` alias case.
      adapters: new Map([['telegram', { ...makeAdapter(), id: 'telegram' }]]),
      clarifySweepIntervalMs: 0,
      botSpendSince: async () => ({ repliesUsd: 0, backgroundUsd: 1 }),
    });
    expect(
      await gateway.backgroundGate({ kind: 'memory_capture', attribution: { botKey: 'bot-1' } }),
    ).toEqual({ decision: 'skip', spentUsd: 1, capUsd: 1 });
  });

  it('a bot with no daily cap never skips a background call', async () => {
    const gateway = new Gateway({
      bots: [{ botKey: 'bot-1', loop: makeLoop([]), binding: { type: 'personality', name: 'r' } }],
      clarifySweepIntervalMs: 0,
      botSpendSince: async () => ({ repliesUsd: 0, backgroundUsd: 100 }),
    });
    expect(
      await gateway.backgroundGate({ kind: 'memory_capture', attribution: { botKey: 'bot-1' } }),
    ).toEqual({ decision: 'allow' });
  });

  it('(2) with backgroundBlocksReplies: true, background spend refuses the reply', async () => {
    const { gateway, loop, adapter, blocks } = capped(
      async () => ({ repliesUsd: 0, backgroundUsd: 1 }),
      { backgroundBlocksReplies: true },
    );
    await gateway.handleMessage(inbound('hi'), adapter);
    expect(loop.runs).toBe(0);
    expect(adapter.sent[0]).toContain('daily budget');
    expect(blocks.map((b) => b.code)).toContain('gateway.daily_budget_refused');
  });

  it('(3) reply spend (turns + in-turn utility) at the cap refuses the message, as before', async () => {
    const { gateway, loop, adapter, blocks } = capped(async () => ({
      repliesUsd: 1,
      backgroundUsd: 0,
    }));
    await gateway.handleMessage(inbound('hi'), adapter);
    expect(loop.runs).toBe(0);
    expect(adapter.sent[0]).toContain('daily budget');
    const refused = blocks.find((b) => b.code === 'gateway.daily_budget_refused');
    expect(refused?.details).toMatchObject({ spentUsd: 1, capUsd: 1 });
  });

  it('(4) an unreadable figure: gate allows, reply allowed, unreadable recorded', async () => {
    const { gateway, loop, adapter, blocks } = capped(async () => {
      throw new Error('sessions.db locked');
    });
    expect(
      await gateway.backgroundGate({ kind: 'memory_capture', attribution: { botKey: 'bot-1' } }),
    ).toEqual({ decision: 'allow' });
    await gateway.handleMessage(inbound('hi'), adapter);
    expect(loop.runs).toBe(1);
    expect(blocks.filter((b) => b.code === 'gateway.daily_budget_unreadable').length).toBe(2);
  });

  it('/budget splits today’s spend into replies and background', async () => {
    const { gateway, adapter } = capped(async () => ({ repliesUsd: 0.25, backgroundUsd: 0.1 }));
    await gateway.handleMessage(inbound('/budget'), adapter);
    expect(adapter.sent[0]).toContain(
      'Bot spend today (UTC): $0.3500 of a $1.00 daily cap ($0.2500 replies, $0.1000 background)',
    );
  });
});
