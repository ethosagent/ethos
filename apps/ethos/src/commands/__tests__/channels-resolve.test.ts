// `ethos channels resolve|list` (plan channel-prompts §7 L9): an offline view of
// what the gateway would resolve for a room, over InMemoryStorage + a config.

import type { ChannelsPlatformConfig, EthosConfig, RawRoomEntry } from '@ethosagent/config';
import { ethosDir } from '@ethosagent/config';
import { RoomTurnPolicies } from '@ethosagent/gateway';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { EthosError } from '@ethosagent/types';
import { previewRoomPolicyJson } from '@ethosagent/wiring/room-policy';
import { describe, expect, it } from 'vitest';
import { type ChannelsCliIo, runChannelsCommand } from '../channels';
import { loadRoomPolicies } from '../gateway';

const entries = (e: Record<string, RawRoomEntry>): ChannelsPlatformConfig['entries'] =>
  Object.assign(Object.create(null), e);

const config = (channels: Record<string, ChannelsPlatformConfig>): EthosConfig =>
  ({ channels }) as unknown as EthosConfig;

function io(): ChannelsCliIo & { lines: string[]; text: () => string } {
  const lines: string[] = [];
  return { lines, out: (l) => lines.push(l), text: () => lines.join('\n') };
}

async function run(
  args: string[],
  cfg: EthosConfig,
  files: Record<string, string> = {},
): Promise<{ out: ReturnType<typeof io> }> {
  const storage = new InMemoryStorage();
  for (const [rel, body] of Object.entries(files)) {
    const path = `${ethosDir()}/channels/${rel}`;
    await storage.mkdir(path.slice(0, path.lastIndexOf('/')));
    await storage.write(path, body);
  }
  const out = io();
  await runChannelsCommand(args, { config: cfg, storage, io: out });
  return { out };
}

const telegramCfg = config({
  telegram: {
    entries: entries({
      '-100123': { prompt: 'Parent room prompt.', skills: ['triage'], mode: 'mention' },
      '-100123.topics.7': { prompt: 'Topic seven prompt.', silent: true },
    }),
  },
});

describe('ethos channels resolve', () => {
  it('Telegram topic: two layers, parent then topic, silence line, digest', async () => {
    const { out } = await run(['resolve', 'telegram', '-100123', '7'], telegramCfg);
    const t = out.text();
    expect(t).toContain('-100123.topics.7');
    expect(t).toContain('topic');
    expect(t).toContain('-100123');
    expect(t).toMatch(/Parent room prompt\.\n\nTopic seven prompt\./);
    expect(t).toContain('To send nothing in this room, reply with exactly NO_REPLY.');
    expect(t).toContain('skills: triage');
    expect(t).toContain('silent: true');
    expect(t).toMatch(/digest: [0-9a-f]{8}/);
    expect(t).toContain('bot handle is unknown offline');
  });

  it('Slack wildcard answers a room with no entry of its own', async () => {
    const cfg = config({
      slack: { entries: entries({ '*': { prompt: 'Any channel.' }, '*dm': { prompt: 'DM.' } }) },
    });
    const { out } = await run(['resolve', 'slack', 'C999', '--json'], cfg);
    const j = JSON.parse(out.lines[0] ?? '');
    expect(j.match).toEqual({ key: '*', source: 'wildcard', layers: ['*'] });
    expect(j.block).toBe('Any channel.');
  });

  it('--dm uses *dm, not *', async () => {
    const cfg = config({
      slack: { entries: entries({ '*': { prompt: 'Any channel.' }, '*dm': { prompt: 'DM.' } }) },
    });
    const { out } = await run(['resolve', 'slack', 'D1', '--dm', '--json'], cfg);
    const j = JSON.parse(out.lines[0] ?? '');
    expect(j.isDm).toBe(true);
    expect(j.match.key).toBe('*dm');
    expect(j.block).toBe('DM.');
  });

  it('--name matches a name selector only when allowNameMatching is on', async () => {
    const cfg = config({
      slack: {
        allowNameMatching: true,
        entries: entries({ 'name:ops-alerts': { prompt: 'Ops.' } }),
      },
    });
    const { out } = await run(['resolve', 'slack', 'C1', '--name', 'Ops Alerts', '--json'], cfg);
    const j = JSON.parse(out.lines[0] ?? '');
    expect(j.match.source).toBe('name');
    expect(j.match.key).toBe('name:ops-alerts');
  });

  it('--json is one stable document', async () => {
    const { out } = await run(['resolve', 'telegram', '-100123', '7', '--json'], telegramCfg);
    expect(out.lines).toHaveLength(1);
    const j = JSON.parse(out.lines[0] ?? '');
    expect(Object.keys(j).sort()).toEqual(
      [
        'block',
        'chatId',
        'digest',
        'fields',
        'identityLineOmitted',
        'isDm',
        'match',
        'ok',
        'platform',
        'promptLayers',
        'roomName',
        'threadId',
        'warnings',
      ].sort(),
    );
    expect(j.ok).toBe(true);
    expect(j.identityLineOmitted).toBe(true);
    expect(j.match).toEqual({
      key: '-100123.topics.7',
      source: 'topic',
      layers: ['-100123.topics.7', '-100123'],
    });
    expect(Object.keys(j.fields).sort()).toEqual(
      ['identity', 'metadata', 'mode', 'modeKey', 'model', 'silent', 'skills', 'tier'].sort(),
    );
    expect(j.fields.skills).toEqual(['triage']);
    expect(j.fields.mode).toBe('mention');
    expect(j.fields.modeKey).toBe('-100123');
    expect(j.promptLayers.map((l: { key: string }) => l.key)).toEqual([
      '-100123',
      '-100123.topics.7',
    ]);
    expect(j.digest).toMatch(/^[0-9a-f]{8}$/);
    expect(j.threadId).toBe('7');
    expect(j.roomName).toBeNull();
  });

  it('reads prompt files and reports boot warnings', async () => {
    const cfg = config({ slack: { entries: entries({ C1: { skills: ['a'] } }) } });
    const { out } = await run(['resolve', 'slack', 'C1', '--json'], cfg, {
      'slack/C1.md': 'From a file.',
      'slack/name_ ?.md': 'x',
    });
    const j = JSON.parse(out.lines[0] ?? '');
    expect(j.block).toBe('From a file.');
    expect(j.warnings.join('\n')).toContain('no usable name');
  });

  it('unknown platform with no entries: EthosError naming the configured ones', async () => {
    const err = await run(['resolve', 'matrix', 'R1'], telegramCfg).catch((e) => e);
    expect(err).toBeInstanceOf(EthosError);
    expect(err.code).toBe('INVALID_INPUT');
    expect(err.cause).toContain('matrix');
    expect(err.cause).toContain('telegram');
  });

  it.each([
    [['resolve']],
    [['resolve', 'slack']],
    [['bogus']],
    [[]],
    [['resolve', 'slack', 'C1', '--name']],
  ])('bad args %j: EthosError with usage', async (args) => {
    const err = await run(args, telegramCfg).catch((e) => e);
    expect(err).toBeInstanceOf(EthosError);
    expect(err.code).toBe('INVALID_INPUT');
    expect(err.action).toContain('ethos channels');
  });
});

describe('ethos channels resolve: whole-block cap', () => {
  const overCap = config({
    telegram: {
      entries: entries({
        // Each layer fits its own 4,000-char cap; the chain (8,002+) busts the block cap.
        '-100': { prompt: `parent ${'p'.repeat(3993)}` },
        '-100.topics.7': { prompt: `topic ${'t'.repeat(3994)}` },
      }),
    },
  });

  it('--json block and digest equal the live (identity-off) turn: the most specific layer is dropped', async () => {
    const { out } = await run(['resolve', 'telegram', '-100', '7', '--json'], overCap);
    const j = JSON.parse(out.lines[0] ?? '');
    expect(j.block.length).toBeLessThanOrEqual(8000);
    expect(j.block).toContain('parent ');
    expect(j.block).not.toContain('topic ');
    const live = new RoomTurnPolicies(overCap.channels as never).forTurn(
      { platform: 'telegram', chatId: '-100', threadId: '7', isDm: false },
      undefined,
    );
    expect(live?.trimmed).toEqual(['-100.topics.7']);
    expect(j.digest).toBe(live?.digest);
  });
});

describe('ethos channels list', () => {
  it('prints every selector per platform with fields set and source', async () => {
    const cfg = config({
      slack: { entries: entries({ C1: { skills: ['a'], silent: true }, '*': { prompt: 'p' } }) },
      telegram: { entries: entries({ '-1': { model: 'sonnet' } }) },
    });
    const { out } = await run(['list'], cfg, { 'telegram/-1.md': 'File prompt.' });
    const t = out.text();
    expect(t).toMatch(/slack/);
    expect(t).toMatch(/C1\s+skills, silent\s+config/);
    expect(t).toMatch(/\*\s+prompt\s+config/);
    expect(t).toMatch(/-1\s+prompt, model\s+config \+ .*channels\/telegram\/-1\.md/);
  });

  it('a file-only selector shows the file path; --json mirrors it', async () => {
    const { out } = await run(['list', '--json'], config({}), { 'discord/_dms.md': 'DM text.' });
    const j = JSON.parse(out.lines[0] ?? '');
    expect(j.ok).toBe(true);
    expect(j.platforms.discord.entries).toEqual([
      {
        selector: '*dm',
        fields: ['prompt'],
        sources: [`${ethosDir()}/channels/discord/_dms.md`],
      },
    ]);
  });

  it('nothing configured: says so', async () => {
    const { out } = await run(['list'], config({}));
    expect(out.text()).toContain('No room entries');
  });
});

describe('ethos channels resolve --json is previewRoomPolicyJson (plan channel-prompts-ui D13)', () => {
  const cases: Array<[string, string[]]> = [
    ['telegram topic', ['resolve', 'telegram', '-100123', '7', '--json']],
    ['telegram room', ['resolve', 'telegram', '-100123', '--json']],
    ['no match', ['resolve', 'telegram', '-999', '--json']],
    ['dm + name', ['resolve', 'telegram', '-100123', '--dm', '--name', 'Ops Room', '--json']],
  ];
  it.each(cases)('%s: byte-identical to the shared function', async (_n, args) => {
    const { out } = await run(args, telegramCfg);
    const storage = new InMemoryStorage();
    const { table, warnings } = await loadRoomPolicies(storage, telegramCfg);
    const [, platform = '', chatId = '', ...rest] = args;
    const threadId = /^\d+$/.test(rest[0] ?? '') ? rest[0] : undefined;
    const nameAt = args.indexOf('--name');
    const expected = previewRoomPolicyJson(
      table ?? {},
      {
        platform,
        chatId,
        isDm: args.includes('--dm'),
        ...(threadId ? { threadId } : {}),
        ...(nameAt >= 0 ? { roomName: args[nameAt + 1] as string } : {}),
      },
      warnings,
    );
    expect(out.lines).toEqual([JSON.stringify(expected)]);
  });
});
