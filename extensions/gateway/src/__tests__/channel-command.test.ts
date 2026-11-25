// `/channel` (plan channel-prompts §3.12, D17, L8): a gateway command that
// never reaches the model. The summary is open to the room; `show` is owner-only
// and DM-only. Formatting is pure (`channel-command.ts`); the gateway tests
// drive the real `Gateway.handleMessage`.

import type { AgentLoop } from '@ethosagent/core';
import type {
  DeliveryResult,
  InboundMessage,
  OutboundMessage,
  PlatformAdapter,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import {
  CHANNEL_SHOW_GROUP_TEXT,
  CHANNEL_SHOW_NOT_OWNER_TEXT,
  channelShowAccess,
  formatChannelShow,
  formatChannelSummary,
  isChannelShowArg,
  parseChannelModeSource,
} from '../channel-command';
import { PLATFORM_COMMANDS } from '../gateway-pure';
import { Gateway } from '../index';
import { type RoomPolicyTable, resolveRoomPolicy } from '../room-policy';
import { RoomTurnPolicies } from '../room-turn';

const GROUP = '-1001234567890';

const TABLE: RoomPolicyTable = {
  telegram: {
    entries: {
      [GROUP]: { prompt: 'Be an incident commander.', mode: 'mention_only' },
      [`${GROUP}.topics.99`]: {
        prompt: 'Topic 99 is the war room.',
        skills: ['incident-template'],
        tier: 'deep',
        silent: true,
        mode: 'all',
      },
    },
  },
};

/** TABLE plus the two wildcards. */
const WILD: RoomPolicyTable = {
  telegram: {
    entries: {
      ...(TABLE.telegram?.entries ?? {}),
      '*': { prompt: 'wild' },
      '*dm': { prompt: 'dm wild', model: 'fast' },
    },
  },
};

function summarize(
  table: RoomPolicyTable | undefined,
  over: {
    chatId?: string;
    threadId?: string;
    isDm?: boolean;
    platform?: string;
    handle?: string;
    channelMode?: string;
    channelModeSource?: 'runtime' | 'room' | 'platform' | 'default';
  } = {},
): string {
  const input = {
    platform: over.platform ?? 'telegram',
    chatId: over.chatId ?? GROUP,
    ...(over.threadId ? { threadId: over.threadId } : {}),
    isDm: over.isDm ?? false,
  };
  const identity = over.handle ? { handle: over.handle, isDm: input.isDm } : undefined;
  const view = new RoomTurnPolicies(table).inspect(input, identity);
  return formatChannelSummary({
    ...input,
    configured: view.configured,
    ...(view.resolved ? { resolved: view.resolved } : {}),
    ...(view.turn ? { turn: view.turn } : {}),
    ...(identity ? { identity } : {}),
    ...(over.channelMode ? { channelMode: over.channelMode } : {}),
    ...(over.channelModeSource ? { channelModeSource: over.channelModeSource } : {}),
  });
}

describe('formatChannelSummary (pure)', () => {
  it('a Telegram topic: room line, topic → parent chain, layers, skills, tier, mode', () => {
    const out = summarize(TABLE, { threadId: '99', handle: 'atlas_bot' });
    const lines = out.split('\n');
    expect(lines[0]).toBe(`Room: telegram · ${GROUP} · topic 99`);
    expect(lines[1]).toBe(
      `Matched: ${GROUP}.topics.99 (topic) → ${GROUP} (parent) · wildcard not used`,
    );
    expect(lines[2]).toMatch(/^Prompt: 2 layers · \d+ chars · sha [0-9a-f]{8}$/);
    expect(lines[3]).toBe(
      'Skills: incident-template · Model: tier deep · Identity: on (@atlas_bot) · Metadata: off · Silent: on · Mode: all (room config: ' +
        `${GROUP}.topics.99)`,
    );
  });

  it('a plain room: one layer, no thread suffix, silent off, mode from the room key', () => {
    const out = summarize(TABLE, { handle: 'atlas_bot' });
    expect(out).toContain(`Room: telegram · ${GROUP}\n`);
    expect(out).toContain(`Matched: ${GROUP} (direct) · wildcard not used`);
    expect(out).toMatch(/Prompt: 1 layer · /);
    expect(out).toContain('Skills: none · Model: default');
    expect(out).toContain('Silent: off');
    expect(out).toContain(`Mode: mention_only (room config: ${GROUP})`);
  });

  it('a thread on a non-Telegram platform says "thread"', () => {
    const t: RoomPolicyTable = { slack: { entries: { C1: { prompt: 'x' } } } };
    expect(summarize(t, { platform: 'slack', chatId: 'C1', threadId: '1.2' })).toContain(
      'Room: slack · C1 · thread 1.2',
    );
  });

  it('a DM: marked DM, identity off, dm wildcard used', () => {
    const out = summarize(WILD, { chatId: 'u-1', isDm: true, handle: 'atlas_bot' });
    expect(out).toContain('Room: telegram · u-1 · DM');
    expect(out).toContain('Matched: *dm (wildcard) · wildcard *dm used');
    expect(out).toContain('Identity: off (DM)');
    expect(out).toContain('Model: model fast');
  });

  it('a wildcard-only match reports the wildcard', () => {
    const out = summarize(WILD, { chatId: 'other-room' });
    expect(out).toContain('Matched: * (wildcard) · wildcard * used');
  });

  it('a chain that also borrows the wildcard says so', () => {
    const t: RoomPolicyTable = {
      telegram: { entries: { r1: { prompt: 'a' }, '*': { skills: ['s'] } } },
    };
    const out = summarize(t, { chatId: 'r1' });
    expect(out).toContain('Matched: r1 (direct) · wildcard * used');
    expect(out).toContain('Skills: s');
  });

  it('no match: says so and keeps the room coordinates', () => {
    const t: RoomPolicyTable = { telegram: { entries: { other: { prompt: 'x' } } } };
    expect(summarize(t, { chatId: 'nope', threadId: '5' })).toBe(
      'No room policy for this room.\nRoom: telegram · nope · topic 5',
    );
  });

  it('a platform the table does not mention is "no room policy"', () => {
    expect(summarize(TABLE, { platform: 'discord', chatId: 'c' })).toBe(
      'No room policy for this room.\nRoom: discord · c',
    );
  });

  it('no table at all: "not configured", never throws', () => {
    expect(summarize(undefined)).toBe(
      `Room policies are not configured.\nRoom: telegram · ${GROUP}`,
    );
    expect(summarize({})).toContain('Room policies are not configured.');
  });

  it('an entry with no prompt says Prompt: none', () => {
    const t: RoomPolicyTable = { telegram: { entries: { r: { skills: ['s'] } } } };
    expect(summarize(t, { chatId: 'r' })).toContain('Prompt: none');
  });

  it('mode source: the adapter-stamped source wins over the room config guess', () => {
    const base = { threadId: '99' } as const;
    expect(
      summarize(TABLE, { ...base, channelMode: 'observe', channelModeSource: 'runtime' }),
    ).toContain('Mode: observe (runtime override)');
    expect(
      summarize(TABLE, { ...base, channelMode: 'all', channelModeSource: 'platform' }),
    ).toContain('Mode: all (platform default)');
    expect(summarize(TABLE, { ...base, channelMode: 'all', channelModeSource: 'room' })).toContain(
      `Mode: all (room config: ${GROUP}.topics.99)`,
    );
  });

  it('never prints prompt text', () => {
    expect(summarize(TABLE, { threadId: '99' })).not.toContain('war room');
  });

  it('the mode source parser accepts only the four known values', () => {
    expect(parseChannelModeSource('room')).toBe('room');
    expect(parseChannelModeSource('bogus')).toBeUndefined();
    expect(parseChannelModeSource(undefined)).toBeUndefined();
  });

  it('the resolver and the summary agree on the chain', () => {
    const r = resolveRoomPolicy(TABLE, {
      platform: 'telegram',
      chatId: GROUP,
      threadId: '99',
      isDm: false,
    });
    expect(r.layers).toEqual([`${GROUP}.topics.99`, GROUP]);
  });
});

describe('channelShowAccess / formatChannelShow (pure)', () => {
  it('owner in a DM is the only allow', () => {
    expect(channelShowAccess({ isOwner: true, isDm: true })).toBe('allow');
    expect(channelShowAccess({ isOwner: true, isDm: false })).toBe('group');
    expect(channelShowAccess({ isOwner: false, isDm: true })).toBe('not_owner');
    expect(channelShowAccess({ isOwner: false, isDm: false })).toBe('not_owner');
  });

  it('isChannelShowArg is the second token, case-insensitive', () => {
    expect(isChannelShowArg('/channel show')).toBe(true);
    expect(isChannelShowArg('/channel  SHOW ')).toBe(true);
    expect(isChannelShowArg('/channel')).toBe(false);
    expect(isChannelShowArg('/channel shown')).toBe(false);
  });

  it('formatChannelShow wraps the block, or says none', () => {
    const turn = new RoomTurnPolicies(TABLE).forTurn(
      { platform: 'telegram', chatId: GROUP, isDm: false },
      undefined,
    );
    expect(formatChannelShow(turn)).toContain('Be an incident commander.');
    expect(formatChannelShow(undefined)).toBe('Rendered room block: (none)');
  });

  it('the refusal texts point at the DM and the CLI', () => {
    expect(CHANNEL_SHOW_GROUP_TEXT).toContain('DM');
    expect(CHANNEL_SHOW_GROUP_TEXT).toContain('ethos channels resolve');
    expect(CHANNEL_SHOW_NOT_OWNER_TEXT).toContain('owner');
  });
});

// --- through the real gateway ----------------------------------------------

function adapterFor(platform = 'telegram') {
  const sends: string[] = [];
  const adapter = {
    id: `${platform}:bot-a`,
    displayName: platform,
    capabilities: { platform },
    canSendTyping: false,
    canEditMessage: false,
    canReact: false,
    canSendFiles: false,
    maxMessageLength: 4096,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(async (_c: string, m: OutboundMessage): Promise<DeliveryResult> => {
      sends.push(m.text);
      return { ok: true, messageId: String(sends.length) };
    }),
    onMessage: vi.fn(),
    health: vi.fn().mockResolvedValue({ ok: true }),
    selfIdentity: () => ({ handle: 'atlas_bot' }),
  } as unknown as PlatformAdapter;
  return { adapter, sends };
}

function gatewayFor(adapter: PlatformAdapter, roomPolicies: RoomPolicyTable | undefined) {
  const run = vi.fn(() =>
    (async function* () {
      yield { type: 'done', text: 'model reply', turnCount: 1 };
    })(),
  );
  const loop = { run, hooks: { registerVoid: vi.fn().mockReturnValue(() => {}) } };
  const gw = new Gateway({
    bots: [
      {
        botKey: 'bot-a',
        loop: loop as unknown as AgentLoop,
        binding: { type: 'personality', name: 'default' },
      },
    ],
    adapters: new Map([['telegram', adapter]]),
    channelFilter: { telegram: { ownerUserId: 'owner-1', recipientAllowlist: ['member-9'] } },
    clarifySweepIntervalMs: 0,
    clarifyEscalationDelayMs: 0,
    streamingEditIntervalMs: 0,
    ...(roomPolicies ? { roomPolicies } : {}),
  });
  return { gw, run };
}

function msg(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform: 'telegram',
    chatId: GROUP,
    userId: 'member-9',
    text: '/channel',
    isDm: false,
    isGroupMention: true,
    botKey: 'bot-a',
    messageId: `m-${Math.random().toString(36).slice(2)}`,
    raw: {},
    ...over,
  };
}

describe('Gateway /channel', () => {
  it('is registered as a gateway command', () => {
    expect(PLATFORM_COMMANDS['/channel']).toBe('channel');
  });

  it('answers the summary to anyone in the room, with no prompt text, and never runs the model', async () => {
    const { adapter, sends } = adapterFor();
    const { gw, run } = gatewayFor(adapter, TABLE);
    await gw.handleMessage(msg({ threadId: '99' }), adapter);
    expect(run).not.toHaveBeenCalled();
    expect(sends).toHaveLength(1);
    expect(sends[0]).toContain(`Room: telegram · ${GROUP} · topic 99`);
    expect(sends[0]).toContain(`Matched: ${GROUP}.topics.99 (topic) → ${GROUP} (parent)`);
    expect(sends[0]).toContain('Identity: on (@atlas_bot)');
    expect(sends[0]).not.toContain('war room');
  });

  it('says so when no policy matches', async () => {
    const { adapter, sends } = adapterFor();
    const { gw, run } = gatewayFor(adapter, TABLE);
    await gw.handleMessage(msg({ chatId: 'x' }), adapter);
    expect(sends[0]).toBe('No room policy for this room.\nRoom: telegram · x');
    const wild = gatewayFor(adapter, WILD);
    await wild.gw.handleMessage(msg({ chatId: 'x' }), adapter);
    expect(sends[1]).toContain('Matched: * (wildcard)');
    expect(run).not.toHaveBeenCalled();
    expect(wild.run).not.toHaveBeenCalled();
  });

  it('works when the gateway has no table', async () => {
    const { adapter, sends } = adapterFor();
    const { gw, run } = gatewayFor(adapter, undefined);
    await gw.handleMessage(msg(), adapter);
    expect(sends).toEqual([`Room policies are not configured.\nRoom: telegram · ${GROUP}`]);
    await gw.handleMessage(msg({ text: '/channel show', userId: 'owner-1', isDm: true }), adapter);
    expect(sends[1]).toContain('Room policies are not configured.');
    expect(sends[1]).toContain('Rendered room block: (none)');
    expect(run).not.toHaveBeenCalled();
  });

  it('show: a shared DM (group DM / broadcast) is refused like a group, even for the owner', async () => {
    const { adapter, sends } = adapterFor();
    const { gw } = gatewayFor(adapter, WILD);
    await gw.handleMessage(
      msg({
        text: '/channel show',
        userId: 'owner-1',
        isDm: true,
        audienceHint: 'shared',
        chatId: 'group-dm',
      }),
      adapter,
    );
    expect(sends).toEqual([CHANNEL_SHOW_GROUP_TEXT]);
  });

  it('show: the owner in a DM gets the rendered block', async () => {
    const { adapter, sends } = adapterFor();
    const { gw, run } = gatewayFor(adapter, WILD);
    await gw.handleMessage(
      msg({ text: '/channel show', userId: 'owner-1', isDm: true, chatId: 'owner-dm' }),
      adapter,
    );
    expect(sends).toHaveLength(1);
    expect(sends[0]).toContain('Room: telegram · owner-dm · DM');
    expect(sends[0]).toContain('Rendered room block:');
    expect(sends[0]).toContain('dm wild');
    expect(run).not.toHaveBeenCalled();
  });

  it('show: refused in a group even for the owner, and leaks nothing', async () => {
    const { adapter, sends } = adapterFor();
    const { gw, run } = gatewayFor(adapter, TABLE);
    await gw.handleMessage(
      msg({ text: '/channel show', userId: 'owner-1', threadId: '99' }),
      adapter,
    );
    expect(sends).toEqual([CHANNEL_SHOW_GROUP_TEXT]);
    expect(sends[0]).not.toContain('war room');
    expect(run).not.toHaveBeenCalled();
  });

  it('show: refused for a non-owner, in a DM or a group', async () => {
    const { adapter, sends } = adapterFor();
    const { gw, run } = gatewayFor(adapter, TABLE);
    await gw.handleMessage(msg({ text: '/channel show', isDm: true, chatId: 'dm-2' }), adapter);
    await gw.handleMessage(msg({ text: '/channel show' }), adapter);
    expect(sends).toEqual([CHANNEL_SHOW_NOT_OWNER_TEXT, CHANNEL_SHOW_NOT_OWNER_TEXT]);
    expect(run).not.toHaveBeenCalled();
  });

  it('show: refused when no owner is configured', async () => {
    const { adapter, sends } = adapterFor();
    const gw = new Gateway({
      bots: [
        {
          botKey: 'bot-a',
          loop: { run: vi.fn(), hooks: { registerVoid: vi.fn() } } as unknown as AgentLoop,
          binding: { type: 'personality', name: 'default' },
        },
      ],
      adapters: new Map([['telegram', adapter]]),
      roomPolicies: TABLE,
      clarifySweepIntervalMs: 0,
      clarifyEscalationDelayMs: 0,
    });
    await gw.handleMessage(msg({ text: '/channel show', isDm: true, userId: 'anyone' }), adapter);
    expect(sends).toEqual([CHANNEL_SHOW_NOT_OWNER_TEXT]);
  });

  it('/help lists /channel', async () => {
    const { adapter, sends } = adapterFor();
    const { gw } = gatewayFor(adapter, TABLE);
    await gw.handleMessage(msg({ text: '/help' }), adapter);
    expect(sends[0]).toContain('/channel');
  });

  it('uses the adapter-stamped mode source', async () => {
    const { adapter, sends } = adapterFor();
    const { gw } = gatewayFor(adapter, TABLE);
    await gw.handleMessage(
      Object.assign(msg({ channelMode: 'observe' }), { channelModeSource: 'runtime' }),
      adapter,
    );
    expect(sends[0]).toContain('Mode: observe (runtime override)');
  });
});
