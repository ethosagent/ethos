import { join } from 'node:path';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigRepository } from '../../repositories/config.repository';

const DATA = '/data';

describe('ConfigRepository', () => {
  let storage: InMemoryStorage;
  let repo: ConfigRepository;

  beforeEach(() => {
    storage = new InMemoryStorage();
    repo = new ConfigRepository({ dataDir: DATA, storage });
  });

  it('preserves dotted passthrough keys on read and write', async () => {
    await storage.mkdir(DATA);
    await storage.write(
      join(DATA, 'config.yaml'),
      [
        'provider: anthropic',
        'telegram.bots.0.token: 123:ABC',
        'telegram.bots.0.bind.type: personality',
        'telegram.bots.0.bind.name: researcher',
        'telegram.bots.1.token: 456:DEF',
        'telegram.bots.1.bind.type: team',
        'telegram.bots.1.bind.name: eng',
      ].join('\n') + '\n',
    );

    const config = await repo.read();
    expect(config?.passthrough['telegram.bots.0.token']).toBe('123:ABC');
    expect(config?.passthrough['telegram.bots.0.bind.type']).toBe('personality');
    expect(config?.passthrough['telegram.bots.0.bind.name']).toBe('researcher');
    expect(config?.passthrough['telegram.bots.1.token']).toBe('456:DEF');

    // Update an unrelated field — dotted keys must survive
    await repo.update({ model: 'claude-opus-4-7' });
    const yaml = await storage.read(join(DATA, 'config.yaml'));
    expect(yaml).toContain('telegram.bots.0.token: 123:ABC');
    expect(yaml).toContain('telegram.bots.1.bind.name: eng');
  });

  it('deletePassthroughKeys removes dotted keys', async () => {
    await repo.update({
      passthrough: {
        'telegram.bots.0.token': 'tok',
        'telegram.bots.0.bind.type': 'personality',
        'telegram.bots.0.bind.name': 'researcher',
        telegramToken: 'old',
      },
    });
    await repo.deletePassthroughKeys([
      'telegram.bots.0.token',
      'telegram.bots.0.bind.type',
      'telegram.bots.0.bind.name',
    ]);
    const config = await repo.read();
    expect(config?.passthrough['telegram.bots.0.token']).toBeUndefined();
    expect(config?.passthrough['telegramToken']).toBe('old');
  });
});
