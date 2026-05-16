// biome-ignore-all lint/suspicious/noTemplateCurlyInString: ${secrets:...} refs are the literal config-on-disk format these tests assert
import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigRepository } from '../../repositories/config.repository';
import { PlatformsRepository } from '../../repositories/platforms.repository';

const DATA = '/data';

describe('PlatformsRepository', () => {
  let storage: InMemoryStorage;
  let secrets: InMemorySecretsResolver;
  let configRepo: ConfigRepository;
  let repo: PlatformsRepository;

  beforeEach(() => {
    storage = new InMemoryStorage();
    secrets = new InMemorySecretsResolver();
    configRepo = new ConfigRepository({ dataDir: DATA, storage });
    repo = new PlatformsRepository({ config: configRepo, secrets });
  });

  it('listStatus reports unconfigured for every platform when config is empty', async () => {
    const platforms = await repo.listStatus();
    expect(platforms.map((p) => p.id).sort()).toEqual(['discord', 'email', 'slack', 'telegram']);
    for (const p of platforms) {
      expect(p.configured).toBe(false);
    }
  });

  it('set writes secret-shaped fields through the resolver and stores a ref in config', async () => {
    await repo.set('slack', { botToken: 'xoxb-1', appToken: 'xapp-1', signingSecret: 'shh' });

    // Plaintext lives in the resolver under the canonical refs.
    expect(await secrets.get('slack/botToken')).toBe('xoxb-1');
    expect(await secrets.get('slack/appToken')).toBe('xapp-1');
    expect(await secrets.get('slack/signingSecret')).toBe('shh');

    // Config holds only the indirection — never the plaintext.
    const yaml = await storage.read(join(DATA, 'config.yaml'));
    expect(yaml).toContain('slackBotToken: ${secrets:slack/botToken}');
    expect(yaml).toContain('slackAppToken: ${secrets:slack/appToken}');
    expect(yaml).toContain('slackSigningSecret: ${secrets:slack/signingSecret}');
    expect(yaml).not.toContain('xoxb-1');
    expect(yaml).not.toContain('xapp-1');
    expect(yaml).not.toContain('shh');
  });

  it('set rotates one secret without touching the others', async () => {
    await repo.set('slack', { botToken: 'old-bot', appToken: 'old-app' });
    await repo.set('slack', { signingSecret: 'shh' });
    const status = await repo.getStatus('slack');
    expect(status.configured).toBe(true);
    expect(status.fields).toEqual({ botToken: true, appToken: true, signingSecret: true });

    expect(await secrets.get('slack/botToken')).toBe('old-bot');
    expect(await secrets.get('slack/appToken')).toBe('old-app');
    expect(await secrets.get('slack/signingSecret')).toBe('shh');
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

  it('clear removes the resolver entries AND the config refs', async () => {
    await repo.set('slack', { botToken: 'sb', appToken: 'sa', signingSecret: 'ss' });
    await repo.set('telegram', { token: 'tg' });
    await configRepo.update({ passthrough: { unrelatedKey: 'keep-me' } });

    await repo.clear('slack');

    const yaml = await storage.read(join(DATA, 'config.yaml'));
    expect(yaml).not.toContain('slackBotToken');
    expect(yaml).not.toContain('slackAppToken');
    expect(yaml).not.toContain('slackSigningSecret');
    expect(yaml).toContain('telegramToken: ${secrets:telegram/token}');
    expect(yaml).toContain('unrelatedKey: keep-me');

    expect(await secrets.get('slack/botToken')).toBeNull();
    expect(await secrets.get('slack/appToken')).toBeNull();
    expect(await secrets.get('slack/signingSecret')).toBeNull();
    expect(await secrets.get('telegram/token')).toBe('tg');

    expect((await repo.getStatus('slack')).configured).toBe(false);
  });

  it('non-secret fields (email host/port/user) stay as plaintext', async () => {
    await repo.set('email', {
      imapHost: 'imap.example.com',
      imapPort: '993',
      user: 'alice@example.com',
      password: 'pw',
      smtpHost: 'smtp.example.com',
      smtpPort: '587',
    });

    const yaml = await storage.read(join(DATA, 'config.yaml'));
    expect(yaml).toContain('emailImapHost: imap.example.com');
    expect(yaml).toContain('emailImapPort: 993');
    expect(yaml).toContain('emailUser: alice@example.com');
    expect(yaml).toContain('emailSmtpHost: smtp.example.com');
    expect(yaml).toContain('emailSmtpPort: 587');
    // Password is the only secret-shaped field.
    expect(yaml).toContain('emailPassword: ${secrets:email/password}');
    expect(yaml).not.toContain('emailPassword: pw');
    expect(await secrets.get('email/password')).toBe('pw');
  });

  it('set ignores empty / missing fields', async () => {
    await repo.set('telegram', { token: 'existing' });
    await repo.set('telegram', { token: '' });
    expect(await secrets.get('telegram/token')).toBe('existing');
  });
});

// --- multi-bot telegram ---

describe('PlatformsRepository multi-bot telegram', () => {
  let storage: InMemoryStorage;
  let secrets: InMemorySecretsResolver;
  let configRepo: ConfigRepository;
  let repo: PlatformsRepository;

  beforeEach(() => {
    storage = new InMemoryStorage();
    secrets = new InMemorySecretsResolver();
    configRepo = new ConfigRepository({ dataDir: DATA, storage });
    repo = new PlatformsRepository({ config: configRepo, secrets });
  });

  it('listTelegramBots returns empty array when no bots configured', async () => {
    const bots = await repo.listTelegramBots();
    expect(bots).toEqual([]);
  });

  it('addTelegramBot writes token through the resolver and a ref in config', async () => {
    const bot = await repo.addTelegramBot('123:ABC', { type: 'personality', name: 'researcher' });
    expect(bot.tokenConfigured).toBe(true);
    expect(bot.bind).toEqual({ type: 'personality', name: 'researcher' });
    expect(bot.botKey).toHaveLength(24); // sha256 prefix

    // Plaintext lives in the resolver only.
    expect(await secrets.get(`telegram/bots/${bot.botKey}/token`)).toBe('123:ABC');

    const yaml = await storage.read(join(DATA, 'config.yaml'));
    expect(yaml).toContain(`telegram.bots.0.id: ${bot.botKey}`);
    expect(yaml).toContain(`telegram.bots.0.token: \${secrets:telegram/bots/${bot.botKey}/token}`);
    expect(yaml).toContain('telegram.bots.0.bind.type: personality');
    expect(yaml).toContain('telegram.bots.0.bind.name: researcher');
    expect(yaml).not.toContain('123:ABC');
  });

  it('addTelegramBot appends at next index', async () => {
    const first = await repo.addTelegramBot('111:AAA', { type: 'personality', name: 'coder' });
    const second = await repo.addTelegramBot('222:BBB', { type: 'team', name: 'eng' });

    const yaml = await storage.read(join(DATA, 'config.yaml'));
    expect(yaml).toContain(
      `telegram.bots.0.token: \${secrets:telegram/bots/${first.botKey}/token}`,
    );
    expect(yaml).toContain(
      `telegram.bots.1.token: \${secrets:telegram/bots/${second.botKey}/token}`,
    );
    expect(yaml).toContain('telegram.bots.1.bind.type: team');
    expect(await secrets.get(`telegram/bots/${first.botKey}/token`)).toBe('111:AAA');
    expect(await secrets.get(`telegram/bots/${second.botKey}/token`)).toBe('222:BBB');
  });

  it('listTelegramBots returns all configured bots with stable botKeys', async () => {
    const first = await repo.addTelegramBot('111:AAA', { type: 'personality', name: 'coder' });
    const second = await repo.addTelegramBot('222:BBB', { type: 'team', name: 'eng' });

    const bots = await repo.listTelegramBots();
    expect(bots).toHaveLength(2);
    expect(bots[0]?.botKey).toBe(first.botKey);
    expect(bots[1]?.botKey).toBe(second.botKey);
    expect(bots[0]?.bind.name).toBe('coder');
    expect(bots[1]?.bind.name).toBe('eng');
  });

  it('removeTelegramBot deletes the entry, the secret, and re-indexes', async () => {
    await repo.addTelegramBot('111:AAA', { type: 'personality', name: 'coder' });
    const second = await repo.addTelegramBot('222:BBB', { type: 'team', name: 'eng' });
    await repo.addTelegramBot('333:CCC', { type: 'personality', name: 'researcher' });

    await repo.removeTelegramBot(second.botKey);

    const bots = await repo.listTelegramBots();
    expect(bots).toHaveLength(2);
    expect(bots[0]?.bind.name).toBe('coder');
    expect(bots[1]?.bind.name).toBe('researcher');

    // Secret file gone for the removed bot.
    expect(await secrets.get(`telegram/bots/${second.botKey}/token`)).toBeNull();

    const yaml = await storage.read(join(DATA, 'config.yaml'));
    // After re-index, third bot is now at index 1
    expect(yaml).toContain('telegram.bots.1.bind.name: researcher');
    expect(yaml).not.toContain(second.botKey);
  });

  it('removeTelegramBot is a no-op for unknown botKey', async () => {
    await repo.addTelegramBot('123:ABC', { type: 'personality', name: 'coder' });
    await expect(repo.removeTelegramBot('nonexistent')).resolves.not.toThrow();
    expect(await repo.listTelegramBots()).toHaveLength(1);
  });

  it('addTelegramBot preserves existing flat-key telegramToken', async () => {
    await configRepo.update({ passthrough: { telegramToken: 'legacy' } });
    const bot = await repo.addTelegramBot('111:AAA', { type: 'personality', name: 'coder' });

    const yaml = await storage.read(join(DATA, 'config.yaml'));
    expect(yaml).toContain('telegramToken: legacy');
    expect(yaml).toContain(`telegram.bots.0.token: \${secrets:telegram/bots/${bot.botKey}/token}`);
  });

  it('listTelegramBots synthesizes a legacy entry from telegramToken when no multi-bot rows exist', async () => {
    // Simulate a CLI-set legacy bot: ref in passthrough, plaintext in resolver.
    await secrets.set('telegram/token', 'legacy-secret');
    await configRepo.update({
      personality: 'researcher',
      passthrough: { telegramToken: '${secrets:telegram/token}' },
    });

    const bots = await repo.listTelegramBots();
    expect(bots).toHaveLength(1);
    expect(bots[0]?.tokenConfigured).toBe(true);
    expect(bots[0]?.bind).toEqual({ type: 'personality', name: 'researcher' });
    expect(bots[0]?.botKey).toBe('legacy-telegram');
  });

  it('legacy entry is hidden once a multi-bot entry exists (mirrors gateway shim)', async () => {
    await configRepo.update({
      personality: 'researcher',
      passthrough: { telegramToken: 'legacy-plain' },
    });
    await repo.addTelegramBot('111:AAA', { type: 'personality', name: 'coder' });

    const bots = await repo.listTelegramBots();
    expect(bots).toHaveLength(1);
    expect(bots[0]?.bind.name).toBe('coder');
  });

  it('removeTelegramBot(legacy-telegram) clears the legacy fields and resolver entry', async () => {
    await secrets.set('telegram/token', 'legacy-secret');
    await configRepo.update({
      personality: 'researcher',
      passthrough: { telegramToken: '${secrets:telegram/token}' },
    });

    await repo.removeTelegramBot('legacy-telegram');

    expect(await secrets.get('telegram/token')).toBeNull();
    const yaml = await storage.read(join(DATA, 'config.yaml'));
    expect(yaml).not.toContain('telegramToken');
    expect(await repo.listTelegramBots()).toEqual([]);
  });
});

// --- multi-bot slack ---

describe('PlatformsRepository multi-bot slack', () => {
  let storage: InMemoryStorage;
  let secrets: InMemorySecretsResolver;
  let configRepo: ConfigRepository;
  let repo: PlatformsRepository;

  beforeEach(() => {
    storage = new InMemoryStorage();
    secrets = new InMemorySecretsResolver();
    configRepo = new ConfigRepository({ dataDir: DATA, storage });
    repo = new PlatformsRepository({ config: configRepo, secrets });
  });

  it('listSlackApps returns empty array when none configured', async () => {
    expect(await repo.listSlackApps()).toEqual([]);
  });

  it('addSlackApp writes all three tokens through the resolver and refs into config', async () => {
    const app = await repo.addSlackApp(
      { botToken: 'xoxb-1', appToken: 'xapp-1', signingSecret: 'shh' },
      { type: 'personality', name: 'coder' },
    );
    expect(app.botTokenConfigured).toBe(true);
    expect(app.appTokenConfigured).toBe(true);
    expect(app.signingSecretConfigured).toBe(true);
    expect(app.bind).toEqual({ type: 'personality', name: 'coder' });

    expect(await secrets.get(`slack/apps/${app.botKey}/botToken`)).toBe('xoxb-1');
    expect(await secrets.get(`slack/apps/${app.botKey}/appToken`)).toBe('xapp-1');
    expect(await secrets.get(`slack/apps/${app.botKey}/signingSecret`)).toBe('shh');

    const yaml = await storage.read(join(DATA, 'config.yaml'));
    expect(yaml).toContain(`slack.apps.0.id: ${app.botKey}`);
    expect(yaml).toContain(`slack.apps.0.botToken: \${secrets:slack/apps/${app.botKey}/botToken}`);
    expect(yaml).toContain('slack.apps.0.bind.type: personality');
    expect(yaml).not.toContain('xoxb-1');
    expect(yaml).not.toContain('shh');
  });

  it('removeSlackApp deletes the entry, the three secrets, and re-indexes', async () => {
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

    expect(await secrets.get(`slack/apps/${first.botKey}/botToken`)).toBeNull();
    expect(await secrets.get(`slack/apps/${first.botKey}/appToken`)).toBeNull();
    expect(await secrets.get(`slack/apps/${first.botKey}/signingSecret`)).toBeNull();
  });

  it('listSlackApps synthesizes a legacy entry from the slack*Token triple', async () => {
    await secrets.set('slack/botToken', 'xoxb-legacy');
    await secrets.set('slack/appToken', 'xapp-legacy');
    await secrets.set('slack/signingSecret', 'ss-legacy');
    await configRepo.update({
      personality: 'researcher',
      passthrough: {
        slackBotToken: '${secrets:slack/botToken}',
        slackAppToken: '${secrets:slack/appToken}',
        slackSigningSecret: '${secrets:slack/signingSecret}',
      },
    });

    const apps = await repo.listSlackApps();
    expect(apps).toHaveLength(1);
    expect(apps[0]?.botKey).toBe('legacy-slack');
    expect(apps[0]?.bind).toEqual({ type: 'personality', name: 'researcher' });
    expect(apps[0]?.botTokenConfigured).toBe(true);
  });

  it('legacy slack shim requires all three fields (matches gateway shim)', async () => {
    await configRepo.update({
      passthrough: {
        slackBotToken: 'sb',
        slackAppToken: 'sa',
        // signingSecret missing
      },
    });
    const apps = await repo.listSlackApps();
    expect(apps).toEqual([]);
  });

  it('removeSlackApp(legacy-slack) clears the legacy triple and resolver entries', async () => {
    await secrets.set('slack/botToken', 'xoxb');
    await secrets.set('slack/appToken', 'xapp');
    await secrets.set('slack/signingSecret', 'ss');
    await configRepo.update({
      passthrough: {
        slackBotToken: '${secrets:slack/botToken}',
        slackAppToken: '${secrets:slack/appToken}',
        slackSigningSecret: '${secrets:slack/signingSecret}',
      },
    });

    await repo.removeSlackApp('legacy-slack');

    expect(await secrets.get('slack/botToken')).toBeNull();
    expect(await secrets.get('slack/appToken')).toBeNull();
    expect(await secrets.get('slack/signingSecret')).toBeNull();
    expect(await repo.listSlackApps()).toEqual([]);
  });
});
