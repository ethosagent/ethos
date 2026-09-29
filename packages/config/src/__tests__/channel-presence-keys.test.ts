// Plan personality-presence-and-initiative §3 — the per-bot channel-presence
// settings: `replyPrefix` (a template with `{name}` / `{emoji}`) and
// `mentionByName` (opt-in name mentions), on Telegram bots, Slack apps and the
// single Discord bot. A reply prefix usually ends in a space, so the quoted
// spelling must survive the read and the write.

import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { type EthosConfig, ethosDir, readRawConfig, writeConfig } from '../index';

const BASE = ['provider: anthropic', 'model: m', 'apiKey: sk', 'personality: p'];

async function read(lines: string[]): Promise<EthosConfig | null> {
  const storage = new InMemoryStorage();
  await storage.mkdir(ethosDir());
  await storage.write(join(ethosDir(), 'config.yaml'), [...BASE, ...lines].join('\n'));
  return readRawConfig(storage);
}

const TELEGRAM = [
  'telegram.bots.0.token: 123:abc',
  'telegram.bots.0.bind.type: personality',
  'telegram.bots.0.bind.name: owl',
];
const SLACK = [
  'slack.apps.0.botToken: xoxb-1',
  'slack.apps.0.signingSecret: sig',
  'slack.apps.0.bind.type: personality',
  'slack.apps.0.bind.name: owl',
];

describe('channel presence keys', () => {
  it('parses replyPrefix (quoted, trailing space kept) and mentionByName on a Telegram bot', async () => {
    const cfg = await read([
      ...TELEGRAM,
      'telegram.bots.0.replyPrefix: "[{name}] "',
      'telegram.bots.0.mentionByName: true',
    ]);
    expect(cfg?.telegram?.bots[0]?.replyPrefix).toBe('[{name}] ');
    expect(cfg?.telegram?.bots[0]?.mentionByName).toBe(true);
  });

  it('parses them on a Slack app', async () => {
    const cfg = await read([
      ...SLACK,
      'slack.apps.0.replyPrefix: "{emoji} {name}: "',
      'slack.apps.0.mentionByName: true',
    ]);
    expect(cfg?.slack?.apps[0]?.replyPrefix).toBe('{emoji} {name}: ');
    expect(cfg?.slack?.apps[0]?.mentionByName).toBe(true);
  });

  it('parses them on Discord', async () => {
    const cfg = await read(['discord.replyPrefix: "**{name}** "', 'discord.mentionByName: true']);
    expect(cfg?.discord?.replyPrefix).toBe('**{name}** ');
    expect(cfg?.discord?.mentionByName).toBe(true);
  });

  it('leaves both absent when unset — no key, no behaviour change', async () => {
    const cfg = await read([...TELEGRAM, ...SLACK]);
    expect(cfg?.telegram?.bots[0]).not.toHaveProperty('replyPrefix');
    expect(cfg?.telegram?.bots[0]).not.toHaveProperty('mentionByName');
    expect(cfg?.slack?.apps[0]).not.toHaveProperty('replyPrefix');
    expect(cfg?.discord).toBeUndefined();
  });

  it('round-trips through writeConfig', async () => {
    const storage = new InMemoryStorage();
    const cfg = await read([
      ...TELEGRAM,
      'telegram.bots.0.replyPrefix: "[{name}] "',
      'telegram.bots.0.mentionByName: true',
      ...SLACK,
      'slack.apps.0.replyPrefix: "{emoji} "',
      'discord.replyPrefix: "{name}: "',
      'discord.mentionByName: true',
    ]);
    if (!cfg) throw new Error('config did not parse');
    await storage.mkdir(ethosDir());
    await writeConfig(storage, cfg, new InMemorySecretsResolver());
    const back = await readRawConfig(storage);
    expect(back?.telegram?.bots[0]?.replyPrefix).toBe('[{name}] ');
    expect(back?.telegram?.bots[0]?.mentionByName).toBe(true);
    expect(back?.slack?.apps[0]?.replyPrefix).toBe('{emoji} ');
    expect(back?.discord?.replyPrefix).toBe('{name}: ');
    expect(back?.discord?.mentionByName).toBe(true);
  });
});
