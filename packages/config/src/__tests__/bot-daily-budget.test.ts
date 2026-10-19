// Plan openclaw-2026.9.6-gaps D5 — `budget.dailyUsd` under a bot entry is an
// operator setting (EthosConfig, not PersonalityConfig), read by the parser so
// the U4 unknown-key notice stays silent for it, and round-tripped by
// `writeConfig`.

import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import {
  configParseNotices,
  type EthosConfig,
  ethosDir,
  parseConfigYaml,
  readRawConfig,
  writeConfig,
} from '../index';

const base = ['provider: anthropic', 'model: m', 'apiKey: sk', 'personality: p'];
const telegramBot = [
  'telegram.bots.0.token: 123:abc',
  'telegram.bots.0.bind.type: personality',
  'telegram.bots.0.bind.name: researcher',
];
const slackApp = [
  'slack.apps.0.botToken: xoxb-1',
  'slack.apps.0.signingSecret: s1',
  'slack.apps.0.bind.type: personality',
  'slack.apps.0.bind.name: researcher',
];

const parse = (...lines: string[]) => parseConfigYaml([...base, ...lines].join('\n'));

describe('per-bot budget.dailyUsd (D5)', () => {
  it('parses on telegram, slack and whatsapp bot entries', () => {
    const cfg = parse(
      ...telegramBot,
      'telegram.bots.0.budget.dailyUsd: 5',
      ...slackApp,
      'slack.apps.0.budget.dailyUsd: 2.5',
      'whatsapp.0.id: wa1',
      'whatsapp.0.budget.dailyUsd: 1',
    );
    expect(cfg.telegram?.bots[0]?.budget).toEqual({ dailyUsd: 5 });
    expect(cfg.slack?.apps[0]?.budget).toEqual({ dailyUsd: 2.5 });
    expect(cfg.whatsapp?.[0]?.budget).toEqual({ dailyUsd: 1 });
  });

  it('is read — the unknown-key notice stays silent for it', () => {
    const cfg = parse(
      ...telegramBot,
      'telegram.bots.0.budget.dailyUsd: 5',
      ...slackApp,
      'slack.apps.0.budget.dailyUsd: 2.5',
      'whatsapp.0.id: wa1',
      'whatsapp.0.budget.dailyUsd: 1',
    );
    const unread = configParseNotices(cfg).warnings.filter((w) => w.includes('has no effect'));
    expect(unread).toEqual([]);
  });

  it('a misspelled sub-key is named with the real one', () => {
    const cfg = parse(...telegramBot, 'telegram.bots.0.budget.dailyUSD: 5');
    const unread = configParseNotices(cfg).warnings.filter((w) => w.includes('has no effect'));
    expect(unread.join('\n')).toContain("did you mean 'telegram.bots.0.budget.dailyUsd'");
  });

  it('refuses a non-positive or non-numeric cap', () => {
    for (const bad of ['0', '-1', 'lots']) {
      const cfg = parse(...telegramBot, `telegram.bots.0.budget.dailyUsd: ${bad}`);
      expect(configParseNotices(cfg).errors.join('\n')).toContain('budget.dailyUsd');
    }
  });

  it('absent → no budget on the entry', () => {
    expect(parse(...telegramBot).telegram?.bots[0]).not.toHaveProperty('budget');
  });

  it('round-trips through writeConfig', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const original: EthosConfig = {
      provider: 'anthropic',
      model: 'm',
      apiKey: 'sk',
      personality: 'p',
      telegram: {
        bots: [
          {
            token: '123:abc',
            bind: { type: 'personality', name: 'researcher' },
            budget: { dailyUsd: 5 },
          },
        ],
      },
      slack: {
        apps: [
          {
            botToken: 'xoxb-1',
            signingSecret: 's1',
            bind: { type: 'personality', name: 'researcher' },
            budget: { dailyUsd: 2.5 },
          },
        ],
      },
      whatsapp: [{ id: 'wa1', budget: { dailyUsd: 1 } }],
    };
    await writeConfig(storage, original, new InMemorySecretsResolver());
    const reloaded = await readRawConfig(storage);
    expect(reloaded?.telegram?.bots[0]?.budget).toEqual({ dailyUsd: 5 });
    expect(reloaded?.slack?.apps[0]?.budget).toEqual({ dailyUsd: 2.5 });
    expect(reloaded?.whatsapp?.[0]?.budget).toEqual({ dailyUsd: 1 });
  });
});

// background-usage-accounting §7.2 / D14 — `budget.backgroundBlocksReplies`
// makes background spend count toward the reply gate. Default false.
describe('per-bot budget.backgroundBlocksReplies (D14)', () => {
  it('parses true on telegram, slack and whatsapp entries, and false explicitly', () => {
    const cfg = parse(
      ...telegramBot,
      'telegram.bots.0.budget.dailyUsd: 5',
      'telegram.bots.0.budget.backgroundBlocksReplies: true',
      ...slackApp,
      'slack.apps.0.budget.dailyUsd: 2.5',
      'slack.apps.0.budget.backgroundBlocksReplies: true',
      'whatsapp.0.id: wa1',
      'whatsapp.0.budget.dailyUsd: 1',
      'whatsapp.0.budget.backgroundBlocksReplies: false',
    );
    expect(cfg.telegram?.bots[0]?.budget).toEqual({ dailyUsd: 5, backgroundBlocksReplies: true });
    expect(cfg.slack?.apps[0]?.budget).toEqual({ dailyUsd: 2.5, backgroundBlocksReplies: true });
    expect(cfg.whatsapp?.[0]?.budget).toEqual({ dailyUsd: 1, backgroundBlocksReplies: false });
    const unread = configParseNotices(cfg).warnings.filter((w) => w.includes('has no effect'));
    expect(unread).toEqual([]);
  });

  it('absent → the key is not on the budget (default false)', () => {
    const cfg = parse(...telegramBot, 'telegram.bots.0.budget.dailyUsd: 5');
    expect(cfg.telegram?.bots[0]?.budget).toEqual({ dailyUsd: 5 });
  });

  it('a non-boolean is a config error', () => {
    for (const bad of ['yes', '1', '']) {
      const cfg = parse(
        ...telegramBot,
        'telegram.bots.0.budget.dailyUsd: 5',
        `telegram.bots.0.budget.backgroundBlocksReplies: ${bad}`,
      );
      expect(configParseNotices(cfg).errors.join('\n')).toContain('budget.backgroundBlocksReplies');
    }
  });

  it('without budget.dailyUsd is a config error — there is no cap for it to apply to', () => {
    const cfg = parse(...telegramBot, 'telegram.bots.0.budget.backgroundBlocksReplies: true');
    expect(configParseNotices(cfg).errors.join('\n')).toContain('budget.backgroundBlocksReplies');
  });

  it('round-trips through writeConfig', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const original: EthosConfig = {
      provider: 'anthropic',
      model: 'm',
      apiKey: 'sk',
      personality: 'p',
      telegram: {
        bots: [
          {
            token: '123:abc',
            bind: { type: 'personality', name: 'researcher' },
            budget: { dailyUsd: 5, backgroundBlocksReplies: true },
          },
        ],
      },
      slack: {
        apps: [
          {
            botToken: 'xoxb-1',
            signingSecret: 's1',
            bind: { type: 'personality', name: 'researcher' },
            budget: { dailyUsd: 2.5, backgroundBlocksReplies: false },
          },
        ],
      },
      whatsapp: [{ id: 'wa1', budget: { dailyUsd: 1, backgroundBlocksReplies: true } }],
    };
    await writeConfig(storage, original, new InMemorySecretsResolver());
    const reloaded = await readRawConfig(storage);
    expect(reloaded?.telegram?.bots[0]?.budget).toEqual({
      dailyUsd: 5,
      backgroundBlocksReplies: true,
    });
    expect(reloaded?.slack?.apps[0]?.budget).toEqual({
      dailyUsd: 2.5,
      backgroundBlocksReplies: false,
    });
    expect(reloaded?.whatsapp?.[0]?.budget).toEqual({ dailyUsd: 1, backgroundBlocksReplies: true });
  });
});
