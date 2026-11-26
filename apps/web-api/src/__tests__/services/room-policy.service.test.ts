// plan channel-prompts-ui L4 — RoomPolicyService; shared setup in room-policy.service.fixtures.ts.

import { parseConfigYaml } from '@ethosagent/config';
import { describe, expect, it } from 'vitest';
import { ROOM_POLICY_IS_DM_KEY } from '../../../../../extensions/gateway/src/room-turn';
import { runChannelsCommand } from '../../../../ethos/src/commands/channels';
import {
  CONFIG,
  channelLines,
  failure,
  fileOf,
  installRoomPolicyHarness,
  repo,
  seed,
  storage,
  svc,
} from './room-policy.service.fixtures';

installRoomPolicyHarness();

describe('the DM metadata key', () => {
  it('matches the gateway constant the service mirrors', () => {
    expect(ROOM_POLICY_IS_DM_KEY).toBe('roomPolicyIsDm');
  });
});

describe('listRoomPolicies', () => {
  it('lists config-only, file-only and both-source entries with their prompt home', async () => {
    await seed(
      [
        'channels.slack.fetch_metadata: true',
        'channels.slack.C0CFG.prompt: inline text',
        'channels.slack.C0CFG.tier: trivial',
        'channels.slack.C0BOTH.skills: a,b',
        'channels.slack.C0BOTH.silent: false',
        'channels.telegram.-100.prompt: not slack',
      ],
      {
        [fileOf('slack', 'C0BOTH')]: 'from file',
        [fileOf('slack', '_rooms')]: 'wildcard file',
      },
    );
    const out = await svc.listRoomPolicies({ platform: 'slack' });
    expect(out).toMatchObject({
      platform: 'slack',
      allowNameMatching: false,
      fetchMetadata: true,
      modes: ['mention_only', 'thread_follow', 'all', 'observe'],
    });
    const by = Object.fromEntries(out.entries.map((e) => [e.selector, e]));
    expect(Object.keys(by).sort()).toEqual(['*', 'C0BOTH', 'C0CFG']);
    expect(by.C0CFG).toMatchObject({
      kind: 'room',
      source: 'config',
      fields: { tier: 'trivial' },
      prompt: { text: 'inline text', chars: 11, source: 'config', path: null },
    });
    expect(by.C0BOTH).toMatchObject({
      source: 'both',
      fields: { skills: ['a', 'b'], silent: false },
      prompt: { text: 'from file', source: 'file', path: fileOf('slack', 'C0BOTH') },
    });
    expect(by['*']).toMatchObject({ kind: 'rooms', source: 'file' });
    expect(by.C0CFG?.version).toMatch(/^[0-9a-f]{8}$/);
  });

  it('keeps showing a value the build dropped, with the warning beside it', async () => {
    await seed(['channels.slack.C0X.mode: sideways', 'channels.slack.C0X.model: nope']);
    await storage.write(
      CONFIG,
      `${await storage.read(CONFIG)}\nmodelRegistry.fast.modelId: gpt-x\nmodelRegistry.fast.provider: openai`,
    );
    const out = await svc.listRoomPolicies({ platform: 'slack' });
    const e = out.entries.find((x) => x.selector === 'C0X');
    expect(e?.fields.mode).toBe('sideways');
    expect(e?.warnings.join('\n')).toMatch(/mode: 'sideways' is not a reply mode for slack/);
  });

  it('warns about an oversize file and keeps platform-level warnings apart', async () => {
    await seed([], { [fileOf('slack', 'C0BIG')]: 'x'.repeat(17 * 1024) });
    const out = await svc.listRoomPolicies({ platform: 'slack' });
    expect(out.warnings.join('\n')).toMatch(/over 16 KiB/);
  });
});

describe('deleteRoomPolicy', () => {
  it('removes the file and every config line, leaving others alone', async () => {
    await seed(
      [
        'channels.slack.C0X.prompt: p',
        'channels.slack.C0X.silent: true',
        'channels.slack.C0Y.silent: true',
      ],
      {
        [fileOf('slack', 'C0X')]: 'shadowed',
      },
    );
    const cur = (await svc.listRoomPolicies({ platform: 'slack' })).entries.find(
      (e) => e.selector === 'C0X',
    );
    const res = await svc.deleteRoomPolicy({
      platform: 'slack',
      selector: 'C0X',
      expectedVersion: cur?.version ?? '',
    });
    expect(res).toEqual({ ok: true, removed: true });
    expect(await storage.exists(fileOf('slack', 'C0X'))).toBe(false);
    expect(await channelLines()).toEqual(['channels.slack.C0Y.silent: true']);
  });

  it('is idempotent: a missing selector is removed:false, even with a stale version', async () => {
    expect(
      await svc.deleteRoomPolicy({
        platform: 'slack',
        selector: 'C0X',
        expectedVersion: 'abcd1234',
      }),
    ).toEqual({ ok: true, removed: false });
    await seed(['channels.slack.C0X.silent: true']);
    const cur = (await svc.listRoomPolicies({ platform: 'slack' })).entries[0];
    await svc.deleteRoomPolicy({
      platform: 'slack',
      selector: 'C0X',
      expectedVersion: cur?.version ?? '',
    });
    expect(
      await svc.deleteRoomPolicy({
        platform: 'slack',
        selector: 'C0X',
        expectedVersion: cur?.version ?? '',
      }),
    ).toEqual({ ok: true, removed: false });
  });

  it('a stale version is a 409 and removes nothing', async () => {
    await seed(['channels.slack.C0X.silent: true'], { [fileOf('slack', 'C0X')]: 'p' });
    const err = await failure(
      svc.deleteRoomPolicy({ platform: 'slack', selector: 'C0X', expectedVersion: 'deadbeef' }),
    );
    expect(err.code).toBe('CONFIG_CONFLICT');
    expect(await storage.exists(fileOf('slack', 'C0X'))).toBe(true);
  });

  it('partial when the config write fails after the file is gone; the retry finishes', async () => {
    await seed(['channels.slack.C0X.silent: true'], { [fileOf('slack', 'C0X')]: 'p' });
    const cur = (await svc.listRoomPolicies({ platform: 'slack' })).entries[0];
    const real = repo.transform.bind(repo);
    repo.transform = (async () => {
      throw new Error('EACCES');
    }) as typeof repo.transform;
    const partial = await svc.deleteRoomPolicy({
      platform: 'slack',
      selector: 'C0X',
      expectedVersion: cur?.version ?? '',
    });
    expect(partial).toMatchObject({
      ok: false,
      reason: 'partial',
      fileRemoved: true,
      configRemoved: false,
    });
    const listed = (await svc.listRoomPolicies({ platform: 'slack' })).entries;
    expect(listed.map((e) => [e.selector, e.source])).toEqual([['C0X', 'config']]);
    repo.transform = real;
    expect(
      await svc.deleteRoomPolicy({
        platform: 'slack',
        selector: 'C0X',
        expectedVersion: cur?.version ?? '',
      }),
    ).toEqual({ ok: true, removed: true });
    expect(await channelLines()).toEqual([]);
  });
});

describe('setRoomPlatformSettings', () => {
  it('writes only channels.<p>.fetch_metadata and leaves every other line byte-for-byte', async () => {
    const lines = [
      'channels.slack.allow_name_matching: true',
      'channels.slack.*.prompt: Everyone',
      'channels.slack.name:deploys.prompt: x',
      'channels.slack.C0BAD.mode: Bad-Mode',
      'channels.discord.fetch_metadata: false',
    ];
    await seed(lines);
    expect(await svc.setRoomPlatformSettings({ platform: 'slack', fetchMetadata: true })).toEqual({
      ok: true,
      fetchMetadata: true,
    });
    expect(await channelLines()).toEqual([...lines, 'channels.slack.fetch_metadata: true']);
    // flipping replaces in place, no duplicates
    await svc.setRoomPlatformSettings({ platform: 'discord', fetchMetadata: true });
    expect((await channelLines()).filter((l) => l.includes('fetch_metadata'))).toEqual([
      'channels.discord.fetch_metadata: true',
      'channels.slack.fetch_metadata: true',
    ]);
    // allow_name_matching is untouched and has no setter
    expect(await channelLines()).toContain('channels.slack.allow_name_matching: true');
    expect((svc as unknown as Record<string, unknown>).setAllowNameMatching).toBeUndefined();
  });

  it('refuses Telegram and WhatsApp as unsupported and writes nothing', async () => {
    for (const platform of ['telegram', 'whatsapp'] as const) {
      const res = await svc.setRoomPlatformSettings({ platform, fetchMetadata: true });
      expect(res).toMatchObject({ ok: false, reason: 'unsupported' });
    }
    expect(await storage.exists(CONFIG)).toBe(false);
  });

  it('a config failure is a typed partial', async () => {
    repo.transform = (async () => {
      throw new Error('EACCES');
    }) as typeof repo.transform;
    expect(
      await svc.setRoomPlatformSettings({ platform: 'slack', fetchMetadata: true }),
    ).toMatchObject({ ok: false, reason: 'partial' });
  });
});

describe('previewRoomPolicy', () => {
  const lines = [
    'channels.telegram.-1001234567890.skills: incident-template',
    'channels.telegram.-1001234567890.topics.99.identity: true',
  ];
  const files = {
    [fileOf('telegram', '-1001234567890')]: 'Engineering group',
    [fileOf('telegram', '-1001234567890.topics.99')]: 'Incidents topic',
  };

  it('is byte-identical to `ethos channels resolve --json` on the same fixture', async () => {
    await seed(lines, files);
    const rpc = await svc.previewRoomPolicy({
      platform: 'telegram',
      chatId: '-1001234567890',
      threadId: '99',
      isDm: false,
    });
    const out: string[] = [];
    await runChannelsCommand(['resolve', 'telegram', '-1001234567890', '99', '--json'], {
      config: parseConfigYaml((await storage.read(CONFIG)) ?? ''),
      storage,
      io: { out: (l) => out.push(l) },
    });
    expect(JSON.stringify(rpc)).toBe(out[0]);
    expect(rpc.match.source).toBe('topic');
    expect(rpc.block).toContain('Engineering group');
  });

  it('a draft overlays the preview and never writes', async () => {
    await seed(lines, files);
    const cfgBefore = await storage.read(CONFIG);
    const base = await svc.previewRoomPolicy({
      platform: 'telegram',
      chatId: '-1001234567890',
      isDm: false,
    });
    const draft = await svc.previewRoomPolicy({
      platform: 'telegram',
      chatId: '-1001234567890',
      isDm: false,
      draft: { selector: '-1001234567890', entry: { prompt: 'Draft prompt', silent: true } },
    });
    expect(draft.block).toContain('Draft prompt');
    expect(draft.fields.silent).toBe(true);
    expect(base.block).not.toContain('Draft prompt');
    expect(await storage.read(CONFIG)).toBe(cfgBefore);
    expect(await storage.read(fileOf('telegram', '-1001234567890'))).toBe('Engineering group');
  });

  it('a draft the boot build would drop is refused like a save', async () => {
    const err = await failure(
      svc.previewRoomPolicy({
        platform: 'slack',
        chatId: 'C0X',
        isDm: false,
        draft: { selector: 'C0X', entry: { mode: 'nope' } },
      }),
    );
    expect(err.code).toBe('INVALID_INPUT');
  });

  it('an unconfigured platform previews as no match instead of throwing', async () => {
    const res = await svc.previewRoomPolicy({
      platform: 'discord',
      chatId: '1180000000000000000',
      isDm: false,
    });
    expect(res.match.source).toBe('none');
    expect(res.block).toBeNull();
  });
});
