import type { AgentLoop } from '@ethosagent/core';
import { DefaultHookRegistry } from '@ethosagent/core';
import { initPairingDb } from '@ethosagent/safety-channel';
import Database from '@ethosagent/sqlite';
import type { DeliveryResult, InboundMessage, PlatformAdapter } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Gateway, type GatewayObservability } from '../index';

// `channel.pairing` audit rows (`Gateway.recordPairing`): one when a pairing code
// is ISSUED to an unknown DM sender, one when an `/allow` redemption FAILS. The
// code itself is never in the row. An approval keeps its `channel.allow` row.

const OWNER = 'owner-1';

function fakeLoop(): AgentLoop {
  return {
    hooks: new DefaultHookRegistry(),
    async *run() {
      yield { type: 'done' as const, text: '', turnCount: 1 };
    },
  } as unknown as AgentLoop;
}

function fakeAdapter(): PlatformAdapter & { sent: string[] } {
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
      return { ok: true, messageId: 'm1' };
    },
    onMessage() {},
    async health() {
      return { ok: true };
    },
    sent,
  };
}

function dm(userId: string, text: string): InboundMessage {
  return {
    platform: 'telegram',
    botKey: 'bot-1',
    chatId: `chat-${userId}`,
    userId,
    text,
    isDm: true,
    isGroupMention: false,
    messageId: `msg-${Math.random()}`,
    raw: null,
  };
}

type Row = { code?: string; cause?: string; details?: Record<string, unknown> };

function makeObs() {
  return {
    recordSafetyBlock: vi.fn<(opts: Row) => void>(),
    recordChannelAllow: vi.fn<(opts: Row) => void>(),
    recordChannelDeny: vi.fn<(opts: Row) => void>(),
    recordChannelPairing: vi.fn<(opts: Row) => void>(),
  } satisfies GatewayObservability;
}

let db: Database.Database;
let obs: ReturnType<typeof makeObs>;
let gateway: Gateway;
let adapter: ReturnType<typeof fakeAdapter>;

beforeEach(() => {
  db = new Database(':memory:');
  initPairingDb(db);
  obs = makeObs();
  gateway = new Gateway({
    bots: [
      {
        botKey: 'bot-1',
        loop: fakeLoop(),
        binding: { type: 'personality', name: 'researcher', allowSlashSwitch: false },
      },
    ],
    clarifySweepIntervalMs: 0,
    channelFilter: { telegram: { ownerUserId: OWNER, dmPolicy: 'pairing' } },
    pairingDb: db,
    observability: obs,
  });
  adapter = fakeAdapter();
});
afterEach(() => db.close());

async function issueCode(sender: string): Promise<string> {
  await gateway.handleMessage(dm(sender, 'hi'), adapter);
  const code = adapter.sent.at(-1)?.match(/\/allow ([A-Z0-9]+)/)?.[1];
  if (!code) throw new Error('no pairing code sent');
  return code;
}

describe('channel.pairing audit rows', () => {
  it('records an issued code with platform, botKey and sender, but never the code', async () => {
    const code = await issueCode('stranger');

    expect(obs.recordChannelPairing).toHaveBeenCalledTimes(1);
    const row = obs.recordChannelPairing.mock.calls[0]?.[0];
    expect(row).toEqual({
      code: 'channel.pairing.issued',
      details: { platform: 'telegram', botKey: 'bot-1', senderId: 'stranger', outcome: 'issued' },
    });
    expect(JSON.stringify(row)).not.toContain(code);
  });

  it('records a redemption of an unknown code as not_found, without the code', async () => {
    await gateway.handleMessage(dm(OWNER, '/allow ZZZZ9999'), adapter);

    expect(obs.recordChannelPairing).toHaveBeenCalledWith({
      code: 'channel.pairing.redeem_failed',
      details: { platform: 'telegram', botKey: 'bot-1', senderId: OWNER, outcome: 'not_found' },
    });
    expect(JSON.stringify(obs.recordChannelPairing.mock.calls)).not.toContain('ZZZZ9999');
  });

  it('records an expired code as expired', async () => {
    const code = await issueCode('stranger');
    db.prepare('UPDATE pairing_codes SET issued_at = 0 WHERE code = ?').run(code);
    obs.recordChannelPairing.mockClear();

    await gateway.handleMessage(dm(OWNER, `/allow ${code}`), adapter);

    expect(obs.recordChannelPairing).toHaveBeenCalledTimes(1);
    expect(obs.recordChannelPairing.mock.calls[0]?.[0]).toMatchObject({
      code: 'channel.pairing.redeem_failed',
      details: { outcome: 'expired', codePlatform: 'telegram' },
    });
  });

  it('records the rate-limited attempt as owner_paused', async () => {
    for (let i = 0; i < 6; i++) {
      await gateway.handleMessage(dm(OWNER, `/allow BAD0000${i}`), adapter);
    }

    expect(obs.recordChannelPairing.mock.calls.at(-1)?.[0]).toMatchObject({
      code: 'channel.pairing.redeem_failed',
      details: { outcome: 'owner_paused' },
    });
  });

  it('records a non-owner redemption as not_owner', async () => {
    const code = await issueCode('stranger');
    gateway = new Gateway({
      bots: [
        {
          botKey: 'bot-1',
          loop: fakeLoop(),
          binding: { type: 'personality', name: 'researcher', allowSlashSwitch: false },
        },
      ],
      clarifySweepIntervalMs: 0,
      channelFilter: {
        telegram: { ownerUserId: OWNER, dmPolicy: 'pairing', recipientAllowlist: ['friend'] },
      },
      pairingDb: db,
      observability: obs,
    });
    obs.recordChannelPairing.mockClear();

    await gateway.handleMessage(dm('friend', `/allow ${code}`), adapter);

    expect(obs.recordChannelPairing).toHaveBeenCalledWith({
      code: 'channel.pairing.redeem_failed',
      details: {
        platform: 'telegram',
        botKey: 'bot-1',
        senderId: 'friend',
        outcome: 'not_owner',
        codePlatform: 'telegram',
      },
    });
  });

  it('an approval keeps its channel.allow row and writes no channel.pairing row', async () => {
    const code = await issueCode('stranger');
    obs.recordChannelPairing.mockClear();

    await gateway.handleMessage(dm(OWNER, `/allow ${code}`), adapter);

    expect(obs.recordChannelAllow).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'channel.pairing.approved' }),
    );
    expect(obs.recordChannelPairing).not.toHaveBeenCalled();
  });
});
