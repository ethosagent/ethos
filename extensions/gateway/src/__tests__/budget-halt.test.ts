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
