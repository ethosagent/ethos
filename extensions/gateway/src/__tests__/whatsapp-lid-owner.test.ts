import type { AgentLoop } from '@ethosagent/core';
import { DefaultHookRegistry } from '@ethosagent/core';
import type { ChannelFilterConfig } from '@ethosagent/safety-channel';
import { initPairingDb } from '@ethosagent/safety-channel';
import Database from '@ethosagent/sqlite';
import type { DeliveryResult, InboundMessage, PlatformAdapter } from '@ethosagent/types';
import { afterEach, describe, expect, it } from 'vitest';
import { Gateway } from '../index';

// A WhatsApp sender addressed by LID keeps the LID as `userId` (identity: the
// identity map, sessions and pairing rows key on it); the adapter adds the
// phone JID Baileys supplied as `alternateUserIds`. Every owner check accepts
// either, so an owner configured as the LID stays the owner and one configured
// as the phone JID matches too.

const LID = '987654321012345@lid';
const PHONE = '15559999999@s.whatsapp.net';
const GROUP = '120363000000000000@g.us';

function makeFakeLoop(): AgentLoop & { runArgs: Array<string | undefined> } {
  const runArgs: Array<string | undefined> = [];
  return {
    hooks: new DefaultHookRegistry(),
    async *run(_text: string, opts?: { personalityId?: string }) {
      runArgs.push(opts?.personalityId);
      yield { type: 'done' as const, text: '', turnCount: 1 };
    },
    runArgs,
  } as unknown as AgentLoop & { runArgs: Array<string | undefined> };
}

function makeFakeAdapter(): PlatformAdapter & { sentMessages: string[] } {
  const sentMessages: string[] = [];
  return {
    id: 'whatsapp:bot-1',
    displayName: 'WhatsApp',
    capabilities: { platform: 'test' },
    canSendTyping: false,
    canEditMessage: false,
    canReact: false,
    canSendFiles: false,
    maxMessageLength: 4096,
    async start() {},
    async stop() {},
    async send(_chatId: string, msg: { text: string }): Promise<DeliveryResult> {
      sentMessages.push(msg.text);
      return { ok: true, messageId: 'm1' };
    },
    onMessage() {},
    async health() {
      return { ok: true };
    },
    sentMessages,
  };
}

function lidInbound(text: string, overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform: 'whatsapp',
    botKey: 'bot-1',
    chatId: GROUP,
    userId: LID,
    alternateUserIds: [PHONE],
    text,
    isDm: false,
    isGroupMention: true,
    messageId: `msg-${Date.now()}-${Math.random()}`,
    raw: null,
    ...overrides,
  };
}

const dbs: Database.Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

function makeGateway(
  loop: AgentLoop,
  channelFilter: ChannelFilterConfig,
  pairingDb?: Database.Database,
): Gateway {
  return new Gateway({
    bots: [
      {
        botKey: 'bot-1',
        loop,
        binding: { type: 'personality', name: 'researcher', allowSlashSwitch: true },
      },
    ],
    clarifySweepIntervalMs: 0,
    personalityDirectory: {
      refresh: async () => {},
      has: (id) => id === 'researcher' || id === 'engineer',
      list: () => [
        { id: 'researcher', name: 'Researcher', isDefault: true },
        { id: 'engineer', name: 'Engineer', isDefault: false },
      ],
    },
    channelFilter,
    ...(pairingDb ? { pairingDb } : {}),
  });
}

describe('WhatsApp owner checks accept the LID or its phone alternate', () => {
  it('a LID-configured owner stays the owner when Baileys supplies a phone alt', async () => {
    const adapter = makeFakeAdapter();
    const gateway = makeGateway(makeFakeLoop(), { whatsapp: { ownerUserId: LID } });
    await gateway.handleMessage(lidInbound('/personality engineer'), adapter);
    expect(adapter.sentMessages[0]).toContain('Switched to engineer');
  });

  it('a phone-configured owner matches the LID sender through its alternate', async () => {
    const adapter = makeFakeAdapter();
    const gateway = makeGateway(makeFakeLoop(), { whatsapp: { ownerUserId: PHONE } });
    await gateway.handleMessage(lidInbound('/personality engineer'), adapter);
    expect(adapter.sentMessages[0]).toContain('Switched to engineer');
  });

  it('a phone-configured owner may use /communications from the LID', async () => {
    const db = new Database(':memory:');
    dbs.push(db);
    initPairingDb(db);
    const adapter = makeFakeAdapter();
    const gateway = makeGateway(makeFakeLoop(), { whatsapp: { ownerUserId: PHONE } }, db);
    await gateway.handleMessage(
      lidInbound('/communications', { isDm: true, chatId: LID }),
      adapter,
    );
    expect(adapter.sentMessages[0]).toBe('No pending pairing requests.');
  });

  it('a different sender whose alternate is not the owner is refused', async () => {
    const adapter = makeFakeAdapter();
    const gateway = makeGateway(makeFakeLoop(), {
      whatsapp: { ownerUserId: PHONE, recipientAllowlist: ['111@lid'] },
    });
    await gateway.handleMessage(
      lidInbound('/personality engineer', {
        userId: '111@lid',
        alternateUserIds: ['15550000000@s.whatsapp.net'],
      }),
      adapter,
    );
    expect(adapter.sentMessages[0]).toBe('Only the bot owner can switch personalities in a group.');
  });
});
