// plan personality-memory-boundary D9 / step 3 (open question 9) — the web
// config writers must preserve `gateway.private_chats.<platform>` on an
// unrelated save. `ConfigRepository` does not model the key; it rides on
// `passthrough`, and every web write (settings, per-platform credentials, the
// channel filter editor) goes through `ConfigRepository.update`.

import { join } from 'node:path';
import { parseConfigYaml } from '@ethosagent/config';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigRepository } from '../../repositories/config.repository';
import { PlatformsRepository } from '../../repositories/platforms.repository';

const DATA = '/data';
const PATH = join(DATA, 'config.yaml');
const LISTED = { telegram: ['-1001', '-1002'], slack: ['C0TEAM'] };

describe('web config writers preserve gateway.private_chats', () => {
  let storage: InMemoryStorage;
  let secrets: InMemorySecretsResolver;
  let configRepo: ConfigRepository;
  let platforms: PlatformsRepository;

  beforeEach(async () => {
    storage = new InMemoryStorage();
    secrets = new InMemorySecretsResolver();
    await storage.mkdir(DATA);
    await storage.write(
      PATH,
      [
        'provider: anthropic',
        'model: claude-sonnet-5',
        'personality: researcher',
        'gateway.private_chats.telegram: -1001,-1002',
        'gateway.private_chats.slack: C0TEAM',
      ].join('\n'),
    );
    configRepo = new ConfigRepository({ dataDir: DATA, storage, secrets });
    platforms = new PlatformsRepository({ config: configRepo, secrets });
  });

  async function privateChatsOnDisk() {
    const yaml = (await storage.read(PATH)) ?? '';
    return parseConfigYaml(yaml).gateway?.privateChats;
  }

  it('the file parses as expected before any save', async () => {
    expect(await privateChatsOnDisk()).toEqual(LISTED);
  });

  it('survives an unrelated settings save (ConfigRepository.update)', async () => {
    await configRepo.update({ personality: 'engineer' });
    expect(await privateChatsOnDisk()).toEqual(LISTED);
  });

  it('survives a platform credential save and clear', async () => {
    await platforms.set('telegram', { token: 'tg' });
    expect(await privateChatsOnDisk()).toEqual(LISTED);
    await platforms.clear('telegram');
    expect(await privateChatsOnDisk()).toEqual(LISTED);
  });

  it('survives a channel filter edit on the same platform', async () => {
    await platforms.setChannelFilter('telegram', {
      enabled: true,
      ownerUserId: '42',
      allowlist: ['42'],
    });
    expect(await privateChatsOnDisk()).toEqual(LISTED);
    // …and setting a filter does not fold the list into it.
    expect(await platforms.getChannelFilter('telegram')).toEqual({
      enabled: true,
      ownerUserId: '42',
      allowlist: ['42'],
    });
  });
});
