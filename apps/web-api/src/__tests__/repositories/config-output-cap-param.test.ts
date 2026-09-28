// V-CP-5 / UBP-038 — `providers.<n>.outputCapParam` is modelled by the codec
// the web repository shares with the CLI (`parseProviderChain` /
// `renderProviderChain` in packages/config), and a Settings save keeps every
// stored field the page does not own (`overlayProviderRow` in
// config.service.ts), so a save from the web UI never drops it.

import { join } from 'node:path';
import { parseConfigYaml } from '@ethosagent/config';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { ConfigRepository } from '../../repositories/config.repository';
import { ConfigService } from '../../services/config.service';

const DATA = '/data';
const PATH = join(DATA, 'config.yaml');

const FILE = [
  'provider: azure',
  'model: prod-chat',
  'personality: researcher',
  'providers.0.provider: azure',
  'providers.0.model: prod-chat',
  'providers.0.baseUrl: https://r.openai.azure.com',
  'providers.0.apiVersion: 2024-12-01-preview',
  'providers.0.outputCapParam: max_completion_tokens',
  'providers.1.provider: openrouter',
  'providers.1.model: m',
];

describe('ConfigRepository — providers.<n>.outputCapParam', () => {
  it('survives an unrelated setting save and a Settings chain save', async () => {
    const storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();
    await storage.mkdir(DATA);
    await storage.write(PATH, `${FILE.join('\n')}\n`);
    const repo = new ConfigRepository({ dataDir: DATA, storage, secrets });
    const service = new ConfigService({ config: repo, secrets });

    await repo.update({ verbosity: 'verbose' });
    const { providers, providersVersion } = await service.get();
    await service.update({
      providersVersion,
      verbosity: 'concise',
      providers: providers.map((p, i) => ({
        provider: p.provider,
        sourceIndex: i,
        ...(p.model ? { model: p.model } : {}),
        ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
      })),
    });

    const src = (await storage.read(PATH)) ?? '';
    expect(src.match(/^providers\.0\.outputCapParam: max_completion_tokens$/gm)).toHaveLength(1);
    expect(parseConfigYaml(src).providers?.[0]?.outputCapParam).toBe('max_completion_tokens');
  });
});
