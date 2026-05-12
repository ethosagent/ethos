import { join } from 'node:path';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigRepository } from '../../repositories/config.repository';
import { PlatformsRepository } from '../../repositories/platforms.repository';

const DATA = '/data';

describe('PlatformsRepository', () => {
  let storage: InMemoryStorage;
  let configRepo: ConfigRepository;
  let repo: PlatformsRepository;

  beforeEach(() => {
    storage = new InMemoryStorage();
    configRepo = new ConfigRepository({ dataDir: DATA, storage });
    repo = new PlatformsRepository({ config: configRepo });
  });

  it('listStatus reports unconfigured for every platform when config is empty', async () => {
    const platforms = await repo.listStatus();
    expect(platforms.map((p) => p.id).sort()).toEqual(['discord', 'email', 'slack', 'telegram']);
    for (const p of platforms) {
      expect(p.configured).toBe(false);
    }
  });

  it('set rotates one secret without touching the others', async () => {
    await configRepo.update({
      passthrough: { slackBotToken: 'old-bot', slackAppToken: 'old-app' },
    });
    await repo.set('slack', { signingSecret: 'shh' });
    const status = await repo.getStatus('slack');
    // All three fields populated → fully configured.
    expect(status.configured).toBe(true);
    expect(status.fields).toEqual({ botToken: true, appToken: true, signingSecret: true });

    const yaml = await storage.read(join(DATA, 'config.yaml'));
    expect(yaml).toContain('slackBotToken: old-bot');
    expect(yaml).toContain('slackAppToken: old-app');
    expect(yaml).toContain('slackSigningSecret: shh');
  });

  it('configured stays false when only some fields are set', async () => {
    await repo.set('slack', { botToken: 'b' });
    const status = await repo.getStatus('slack');
    expect(status.configured).toBe(false);
    expect(status.fields).toEqual({ botToken: true, appToken: false, signingSecret: false });
  });

  it('configured flips true when every required field has a non-empty value', async () => {
    await repo.set('slack', { botToken: 'a', appToken: 'b', signingSecret: 'c' });
    const status = await repo.getStatus('slack');
    expect(status.configured).toBe(true);
  });

  it('clear removes all platform-specific keys but preserves other passthrough', async () => {
    await configRepo.update({
      passthrough: {
        telegramToken: 'tg',
        slackBotToken: 'sb',
        slackAppToken: 'sa',
        slackSigningSecret: 'ss',
        unrelatedKey: 'keep-me',
      },
    });
    await repo.clear('slack');

    const yaml = await storage.read(join(DATA, 'config.yaml'));
    expect(yaml).not.toContain('slackBotToken');
    expect(yaml).not.toContain('slackAppToken');
    expect(yaml).not.toContain('slackSigningSecret');
    expect(yaml).toContain('telegramToken: tg');
    expect(yaml).toContain('unrelatedKey: keep-me');

    const status = await repo.getStatus('slack');
    expect(status.configured).toBe(false);
  });

  it('set ignores empty / missing fields', async () => {
    await configRepo.update({ passthrough: { telegramToken: 'existing' } });
    await repo.set('telegram', { token: '' });
    const yaml = await storage.read(join(DATA, 'config.yaml'));
    expect(yaml).toContain('telegramToken: existing');
  });
});

// --- multi-bot telegram ---

describe('PlatformsRepository multi-bot telegram', () => {
  let storage: InMemoryStorage;
  let configRepo: ConfigRepository;
  let repo: PlatformsRepository;

  beforeEach(() => {
    storage = new InMemoryStorage();
    configRepo = new ConfigRepository({ dataDir: DATA, storage });
    repo = new PlatformsRepository({ config: configRepo });
  });

  it('listTelegramBots returns empty array when no bots configured', async () => {
    const bots = await repo.listTelegramBots();
    expect(bots).toEqual([]);
  });

  it('addTelegramBot writes dotted keys and returns the new entry', async () => {
    const bot = await repo.addTelegramBot('123:ABC', { type: 'personality', name: 'researcher' });
    expect(bot.tokenConfigured).toBe(true);
    expect(bot.bind).toEqual({ type: 'personality', name: 'researcher' });
    expect(bot.botKey).toHaveLength(24); // sha256 prefix

    const yaml = await storage.read(join(DATA, 'config.yaml'));
    expect(yaml).toContain('telegram.bots.0.token: 123:ABC');
    expect(yaml).toContain('telegram.bots.0.bind.type: personality');
    expect(yaml).toContain('telegram.bots.0.bind.name: researcher');
  });

  it('addTelegramBot appends at next index', async () => {
    await repo.addTelegramBot('111:AAA', { type: 'personality', name: 'coder' });
    await repo.addTelegramBot('222:BBB', { type: 'team', name: 'eng' });

    const yaml = await storage.read(join(DATA, 'config.yaml'));
    expect(yaml).toContain('telegram.bots.0.token: 111:AAA');
    expect(yaml).toContain('telegram.bots.1.token: 222:BBB');
    expect(yaml).toContain('telegram.bots.1.bind.type: team');
  });

  it('listTelegramBots returns all configured bots', async () => {
    await repo.addTelegramBot('111:AAA', { type: 'personality', name: 'coder' });
    await repo.addTelegramBot('222:BBB', { type: 'team', name: 'eng' });

    const bots = await repo.listTelegramBots();
    expect(bots).toHaveLength(2);
    expect(bots[0]?.bind.name).toBe('coder');
    expect(bots[1]?.bind.name).toBe('eng');
  });

  it('removeTelegramBot deletes the entry and re-indexes', async () => {
    await repo.addTelegramBot('111:AAA', { type: 'personality', name: 'coder' });
    const second = await repo.addTelegramBot('222:BBB', { type: 'team', name: 'eng' });
    await repo.addTelegramBot('333:CCC', { type: 'personality', name: 'researcher' });

    await repo.removeTelegramBot(second.botKey);

    const bots = await repo.listTelegramBots();
    expect(bots).toHaveLength(2);
    expect(bots[0]?.bind.name).toBe('coder');
    expect(bots[1]?.bind.name).toBe('researcher');

    const yaml = await storage.read(join(DATA, 'config.yaml'));
    // After re-index, second bot is now at index 1
    expect(yaml).toContain('telegram.bots.1.bind.name: researcher');
    expect(yaml).not.toContain('222:BBB');
  });

  it('removeTelegramBot is a no-op for unknown botKey', async () => {
    await repo.addTelegramBot('123:ABC', { type: 'personality', name: 'coder' });
    await expect(repo.removeTelegramBot('nonexistent')).resolves.not.toThrow();
    expect(await repo.listTelegramBots()).toHaveLength(1);
  });

  it('addTelegramBot preserves existing flat-key telegramToken', async () => {
    await configRepo.update({ passthrough: { telegramToken: 'legacy' } });
    await repo.addTelegramBot('111:AAA', { type: 'personality', name: 'coder' });

    const yaml = await storage.read(join(DATA, 'config.yaml'));
    expect(yaml).toContain('telegramToken: legacy');
    expect(yaml).toContain('telegram.bots.0.token: 111:AAA');
  });
});

// --- multi-bot slack ---

describe('PlatformsRepository multi-bot slack', () => {
  let storage: InMemoryStorage;
  let configRepo: ConfigRepository;
  let repo: PlatformsRepository;

  beforeEach(() => {
    storage = new InMemoryStorage();
    configRepo = new ConfigRepository({ dataDir: DATA, storage });
    repo = new PlatformsRepository({ config: configRepo });
  });

  it('listSlackApps returns empty array when none configured', async () => {
    expect(await repo.listSlackApps()).toEqual([]);
  });

  it('addSlackApp writes dotted keys and returns the entry', async () => {
    const app = await repo.addSlackApp(
      { botToken: 'xoxb-1', appToken: 'xapp-1', signingSecret: 'shh' },
      { type: 'personality', name: 'coder' },
    );
    expect(app.botTokenConfigured).toBe(true);
    expect(app.appTokenConfigured).toBe(true);
    expect(app.signingSecretConfigured).toBe(true);
    expect(app.bind).toEqual({ type: 'personality', name: 'coder' });

    const yaml = await storage.read(join(DATA, 'config.yaml'));
    expect(yaml).toContain('slack.apps.0.botToken: xoxb-1');
    expect(yaml).toContain('slack.apps.0.bind.type: personality');
  });

  it('removeSlackApp deletes the entry and re-indexes', async () => {
    const first = await repo.addSlackApp(
      { botToken: 'xoxb-1', appToken: 'xapp-1', signingSecret: 's1' },
      { type: 'personality', name: 'coder' },
    );
    await repo.addSlackApp(
      { botToken: 'xoxb-2', appToken: 'xapp-2', signingSecret: 's2' },
      { type: 'team', name: 'eng' },
    );

    await repo.removeSlackApp(first.botKey);
    const apps = await repo.listSlackApps();
    expect(apps).toHaveLength(1);
    expect(apps[0]?.bind.name).toBe('eng');
  });
});
