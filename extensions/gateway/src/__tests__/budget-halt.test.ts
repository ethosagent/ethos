import type { AgentLoop } from '@ethosagent/core';
import { DefaultHookRegistry } from '@ethosagent/core';
import type {
  AgentEvent,
  DeliveryResult,
  InboundMessage,
  PlatformAdapter,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { Gateway } from '../index';

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
