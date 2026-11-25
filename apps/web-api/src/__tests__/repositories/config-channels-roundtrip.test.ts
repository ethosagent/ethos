// plan channel-prompts-ui L1 — `channels.*` lines survive every web config
// write. `ConfigRepository` does not model them; before the claim in `read()`
// the generic `([\w.-]+)` key regex dropped `*`, `@` and `:` selectors and
// rewrote `channels.slack.name:deploys.prompt` into a different key.

import { join } from 'node:path';
import { parseChannelsLine, parseConfigYaml } from '@ethosagent/config';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigRepository } from '../../repositories/config.repository';

const DATA = '/data';
const PATH = join(DATA, 'config.yaml');

const CHANNEL_LINES = [
  'channels.slack.allow_name_matching: true',
  'channels.slack.*.prompt: Everyone gets this',
  'channels.slack.*dm.prompt: DM only',
  'channels.slack.*dm.identity: false',
  'channels.slack.C0X.prompt: "Deploys: confirm env first."',
  'channels.slack.C0X.skills: a,b',
  'channels.slack.name:deploys.prompt: x',
  'channels.slack.C0BAD.silent: maybe',
  'channels.slack.C0BAD.mode: Bad-Mode',
  'channels.telegram.-1001234567890.topics.99.metadata: true',
  'channels.whatsapp.120363000000000000@g.us.prompt: hi',
  'channels.discord.1180000000000000000.prompt: discord room',
];

const lineOf = (text: string, key: string) => text.split('\n').find((l) => l.startsWith(`${key}:`));

describe('ConfigRepository keeps channels.* lines through every write', () => {
  let storage: InMemoryStorage;
  let repo: ConfigRepository;

  const channelsOnDisk = async () =>
    ((await storage.read(PATH)) ?? '').split('\n').filter((l) => l.startsWith('channels.'));

  beforeEach(async () => {
    storage = new InMemoryStorage();
    await storage.mkdir(DATA);
    await storage.write(
      PATH,
      ['provider: anthropic', 'model: m1', 'personality: researcher', ...CHANNEL_LINES].join('\n'),
    );
    repo = new ConfigRepository({
      dataDir: DATA,
      storage,
      secrets: new InMemorySecretsResolver(),
    });
  });

  it('an unrelated passthrough update leaves every line byte-identical, in order', async () => {
    await repo.update({ passthrough: { 'channel_filter.slack.ownerUserId': 'U1' } });
    expect(await channelsOnDisk()).toEqual(CHANNEL_LINES);
  });

  it('a typed-field update and a passthrough delete do too', async () => {
    await repo.update({ personality: 'engineer' });
    expect(await channelsOnDisk()).toEqual(CHANNEL_LINES);
    await repo.deletePassthroughKeys(['channel_filter.slack.ownerUserId']);
    expect(await channelsOnDisk()).toEqual(CHANNEL_LINES);
    await repo.transform((current) => ({ next: { ...current, model: 'm2' }, result: null }));
    expect(await channelsOnDisk()).toEqual(CHANNEL_LINES);
  });

  it('the CLI parser reads the same channels before and after a save', async () => {
    const before = parseConfigYaml((await storage.read(PATH)) ?? '').channels;
    await repo.update({ passthrough: { 'channel_filter.slack.ownerUserId': 'U1' } });
    const after = parseConfigYaml((await storage.read(PATH)) ?? '').channels;
    expect(after).toEqual(before);
    expect(after?.slack?.entries['name:deploys']?.prompt).toBe('x');
    expect(after?.whatsapp?.entries['120363000000000000@g.us']?.prompt).toBe('hi');
  });

  it('an invalid value survives untouched', async () => {
    await repo.update({ personality: 'engineer' });
    const text = (await storage.read(PATH)) ?? '';
    expect(lineOf(text, 'channels.slack.C0BAD.silent')).toBe('channels.slack.C0BAD.silent: maybe');
    expect(lineOf(text, 'channels.slack.C0BAD.mode')).toBe('channels.slack.C0BAD.mode: Bad-Mode');
  });

  it('parseChannelsLine claims every fixture line (the grammar owner)', () => {
    for (const l of CHANNEL_LINES) expect(parseChannelsLine(l)).not.toBeNull();
  });
});

describe('ConfigRepository keeps other unmodelled key: value lines', () => {
  it('a line whose key the generic regex cannot read survives a save', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(DATA);
    await storage.write(
      PATH,
      [
        'provider: anthropic',
        'future.thing@v2: keep me',
        '# a comment',
        'channels.slack.*.bogus: z',
      ].join('\n'),
    );
    const repo = new ConfigRepository({
      dataDir: DATA,
      storage,
      secrets: new InMemorySecretsResolver(),
    });
    await repo.update({ model: 'm2' });
    const lines = ((await storage.read(PATH)) ?? '').split('\n');
    expect(lines).toContain('future.thing@v2: keep me');
    expect(lines).toContain('channels.slack.*.bogus: z');
  });
});
