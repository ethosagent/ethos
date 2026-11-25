// Plan channel-prompts §8: an anonymised Hermes-style setup translated to Ethos.
// Three Slack channels (synthetic ids), each silent with a long multi-line prompt
// kept in a file; channel 1 also binds a skill. Drives the real config parse
// (`channels.*` lines), `buildRoomPolicyTable` with file sources as the loader
// (`readRoomPromptFiles`) would produce them, the resolver, `RoomTurnPolicies`,
// and a real Gateway for the NO_REPLY case. No real emails, URLs or ids.

import { configParseNotices, parseConfigYaml } from '@ethosagent/config';
import type { AgentLoop } from '@ethosagent/core';
import type {
  DeliveryResult,
  InboundMessage,
  OutboundMessage,
  PlatformAdapter,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { Gateway } from '../index';
import {
  buildRoomPolicyTable,
  ROOM_SILENT_LINE,
  type RoomPolicyTable,
  type RoomPromptFile,
  resolveRoomPolicy,
} from '../room-policy';
import { RoomTurnPolicies } from '../room-turn';

const CH1 = 'C0SYNTHAA1';
const CH2 = 'C0SYNTHBB2';
const CH3 = 'C0SYNTHCC3';
const DM = 'D0SYNTHDM9';

/** A generic on-call-gate prompt: multi-line, 2,000+ chars, no real identifiers. */
function gatePrompt(label: string): string {
  const rules = Array.from(
    { length: 14 },
    (_, i) =>
      `${i + 1}. For ${label}, rule ${i + 1}: check the change against the on-call gate before ` +
      'acting, record the decision in the thread, and stay out of conversations that do not ask for it.',
  );
  return [
    `# ${label} on-call gate`,
    '',
    'You watch this channel for change requests and decide whether each one may proceed.',
    'Most messages are not addressed to you. When nothing needs your input, reply with the',
    'silent marker and nothing else.',
    '',
    ...rules,
    '',
    'Escalate anything you cannot decide to the on-call owner by name, in the thread.',
    '',
  ].join('\n');
}

const PROMPTS: Record<string, string> = {
  [CH1]: gatePrompt('Channel one'),
  [CH2]: gatePrompt('Channel two'),
  [CH3]: gatePrompt('Channel three'),
};

const file = (selector: string): RoomPromptFile => ({
  platform: 'slack',
  base: selector,
  path: `/state/channels/slack/${selector}.md`,
  body: PROMPTS[selector] ?? '',
});

function buildTable(): { table: RoomPolicyTable; warnings: string[] } {
  const cfg = parseConfigYaml(
    [
      'provider: anthropic',
      'model: claude-opus-4-7',
      'apiKey: sk',
      'personality: researcher',
      `channels.slack.${CH1}.mode: all`,
      `channels.slack.${CH1}.skills: pr-auto-approve`,
      `channels.slack.${CH1}.silent: true`,
      `channels.slack.${CH2}.mode: all`,
      `channels.slack.${CH2}.silent: true`,
      `channels.slack.${CH3}.mode: all`,
      `channels.slack.${CH3}.silent: true`,
    ].join('\n'),
  );
  expect(configParseNotices(cfg).warnings).toEqual([]);
  return buildRoomPolicyTable({ channels: cfg.channels, files: [CH1, CH2, CH3].map(file) });
}

const { table, warnings } = buildTable();
const policies = new RoomTurnPolicies(table);

describe('Hermes-style setup: three silent Slack channels', () => {
  it('builds without warnings and every prompt is long enough to matter', () => {
    expect(warnings).toEqual([]);
    for (const p of Object.values(PROMPTS)) {
      expect(p.length).toBeGreaterThan(2000);
      expect(p.split('\n').length).toBeGreaterThan(10);
    }
  });

  it.each([CH1, CH2, CH3])('%s: prompt bytes, silent line, mode', (chatId) => {
    const resolved = resolveRoomPolicy(table, { platform: 'slack', chatId, isDm: false });
    expect(resolved.prompt).toBe(PROMPTS[chatId]);
    expect(resolved.mode).toBe('all');
    expect(resolved.silent).toBe(true);

    const turn = policies.forTurn({ platform: 'slack', chatId, isDm: false }, undefined);
    expect(turn?.prompt).toBe(`${PROMPTS[chatId]}\n\n${ROOM_SILENT_LINE}`);
    expect(turn?.silent).toBe(true);
    expect(turn?.trimmed).toEqual([]);
  });

  it('channel 1 binds the skill; channels 2 and 3 bind none', () => {
    const skills = (chatId: string) =>
      policies.forTurn({ platform: 'slack', chatId, isDm: false }, undefined)?.skills;
    expect(skills(CH1)).toEqual(['pr-auto-approve']);
    expect(skills(CH2)).toBeUndefined();
    expect(skills(CH3)).toBeUndefined();
  });

  it('a thread in channel 2 inherits the channel prompt, silence and mode', () => {
    const input = { platform: 'slack', chatId: CH2, threadId: '1700000000.000100', isDm: false };
    const resolved = resolveRoomPolicy(table, input);
    expect(resolved.matchSource).toBe('parent');
    expect(resolved.mode).toBe('all');
    const turn = policies.forTurn(input, undefined);
    expect(turn?.prompt).toBe(`${PROMPTS[CH2]}\n\n${ROOM_SILENT_LINE}`);
    expect(turn?.silent).toBe(true);
  });

  it('a DM gets nothing from these entries', () => {
    const input = { platform: 'slack', chatId: DM, isDm: true };
    const resolved = resolveRoomPolicy(table, input);
    expect(resolved.prompt).toBeUndefined();
    expect(resolved.skills).toBeUndefined();
    expect(resolved.mode).toBeUndefined();
    expect(resolved.silent).toBe(false);
    const turn = policies.forTurn(input, undefined);
    expect(turn?.prompt).toBeUndefined();
    expect(turn?.silent).toBe(false);
  });
});

describe('Hermes-style setup: NO_REPLY through a real Gateway', () => {
  function slackAdapter() {
    const sends: string[] = [];
    const adapter = {
      id: 'slack:bot-a',
      displayName: 'Slack',
      capabilities: { platform: 'slack' },
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
    } as unknown as PlatformAdapter;
    return { adapter, sends };
  }

  async function turn(chatId: string, isDm: boolean) {
    const { adapter, sends } = slackAdapter();
    const calls: Array<Record<string, unknown>> = [];
    const loop = {
      run: vi.fn((_text: string, opts: Record<string, unknown>) => {
        calls.push(opts);
        return (async function* () {
          yield { type: 'text_delta', text: 'NO_REPLY' };
          yield { type: 'done', text: 'NO_REPLY', turnCount: 1 };
        })();
      }),
      hooks: { registerVoid: vi.fn().mockReturnValue(() => {}) },
    };
    const gw = new Gateway({
      bots: [
        {
          botKey: 'bot-a',
          loop: loop as unknown as AgentLoop,
          binding: { type: 'personality', name: 'default' },
        },
      ],
      adapters: new Map([['slack', adapter]]),
      clarifySweepIntervalMs: 0,
      roomPolicies: table,
    });
    const message: InboundMessage = {
      platform: 'slack',
      chatId,
      userId: 'U0SYNTH',
      text: 'please review this change',
      isDm,
      isGroupMention: !isDm,
      botKey: 'bot-a',
      messageId: `m-${Math.random().toString(36).slice(2)}`,
      raw: {},
    };
    await gw.handleMessage(message, adapter);
    await gw.shutdown();
    return { sends, calls, adapter };
  }

  it('a NO_REPLY answer in channel 3 sends nothing, and the turn ran with the room block', async () => {
    const { sends, calls, adapter } = await turn(CH3, false);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.roomPrompt).toBe(`${PROMPTS[CH3]}\n\n${ROOM_SILENT_LINE}`);
    expect(adapter.send).not.toHaveBeenCalled();
    expect(sends).toEqual([]);
  });

  it('the same answer in a DM is ordinary text: these entries do not reach it', async () => {
    const { sends, calls } = await turn(DM, true);
    expect(calls[0]?.roomPrompt).toBeUndefined();
    expect(sends).toEqual(['NO_REPLY']);
  });
});
