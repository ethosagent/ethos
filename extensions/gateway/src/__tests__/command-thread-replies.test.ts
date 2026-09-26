import type { AgentLoop } from '@ethosagent/core';
import { DefaultHookRegistry } from '@ethosagent/core';
import type {
  DeliveryResult,
  InboundMessage,
  OutboundMessage,
  PlatformAdapter,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { Gateway } from '../index';

// A gateway slash command typed inside a Slack thread / Telegram topic answers
// in that thread, like every turn reply does. A reply without `threadId` lands
// in the root chat — in front of an audience that never typed the command.

function makeLoop(): AgentLoop {
  return Object.assign(
    {},
    {
      hooks: new DefaultHookRegistry(),
      async *run() {
        yield { type: 'done' as const, text: 'ok', turnCount: 1 };
      },
      getSessionCost: () => 0,
      resetSessionCost: () => {},
      getPersonalityBudgetCap: () => undefined,
    },
  ) as unknown as AgentLoop;
}

function makeAdapter(): PlatformAdapter & { sent: OutboundMessage[] } {
  const sent: OutboundMessage[] = [];
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
    async send(_chatId: string, msg: OutboundMessage): Promise<DeliveryResult> {
      sent.push(msg);
      return { ok: true, messageId: `m${sent.length}` };
    },
    onMessage() {},
    async health() {
      return { ok: true };
    },
    sent,
  };
}

function threaded(text: string): InboundMessage {
  return {
    platform: 'telegram',
    botKey: 'bot-1',
    chatId: 'C1',
    threadId: 'T1',
    userId: 'u1',
    text,
    isDm: true,
    isGroupMention: false,
    messageId: `msg-${Math.random()}`,
    raw: null,
  };
}

const COMMANDS = [
  '/budget',
  '/budget reset',
  '/stop',
  '/new',
  '/reset',
  '/help',
  '/start',
  '/personality',
  '/personality list',
  '/personality nope',
  '/usage',
  '/allow ABC',
  '/deny',
  '/communications',
  '/queue',
  '/fork',
  '/branches',
  '/branch 1',
  '/mute',
  '/voice',
  '/compact status',
  '/background',
];

describe('gateway slash-command replies stay in the thread', () => {
  it.each(COMMANDS)('%s replies with the inbound threadId', async (command) => {
    const adapter = makeAdapter();
    const gateway = new Gateway({
      bots: [
        {
          botKey: 'bot-1',
          loop: makeLoop(),
          binding: { type: 'personality', name: 'researcher' },
        },
      ],
      clarifySweepIntervalMs: 0,
    });
    await gateway.handleMessage(threaded(command), adapter);
    expect(adapter.sent.length).toBeGreaterThan(0);
    for (const msg of adapter.sent) expect(msg.threadId).toBe('T1');
  });
});
