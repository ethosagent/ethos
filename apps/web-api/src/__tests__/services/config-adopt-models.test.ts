// `config.update` adopt-on-save (D11a): a saved provider row whose model has
// no registry entry is adopted in the SAME config.yaml write, through the one
// importer (`planChainModelImport`), and reported as `adoptedModels`.

import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { ConfigRepository } from '../../repositories/config.repository';
import { ConfigService, type ConfigUpdateInput } from '../../services/config.service';

const DATA = '/data';
const PATH = join(DATA, 'config.yaml');

const USER_CONFIG = [
  'provider: codex',
  'model: gpt-5.6-terra',
  'personality: researcher',
  'approvalMode: smart',
  'modelRouting.writer: default',
  'providers.0.provider: codex',
  'providers.0.id: codex-gpt-terra',
  'providers.0.model: gpt-5.6-terra',
  'someTool.flag: kept',
];

type Rows = NonNullable<ConfigUpdateInput['providers']>;

async function harness(lines: string[]) {
  const storage = new InMemoryStorage();
  await storage.mkdir(DATA);
  await storage.write(PATH, `${lines.join('\n')}\n`);
  let configWrites = 0;
  const writeAtomic = storage.writeAtomic.bind(storage);
  storage.writeAtomic = async (...args: Parameters<typeof writeAtomic>) => {
    if (args[0] === PATH) configWrites++;
    return writeAtomic(...args);
  };
  const secrets = new InMemorySecretsResolver();
  const repo = new ConfigRepository({ dataDir: DATA, storage, secrets });
  const service = new ConfigService({
    config: repo,
    secrets,
    lookupCatalog: () => undefined,
  });
  /** What the Settings page sends for the chain as loaded. */
  const rows = async (): Promise<{ providers: Rows; providersVersion: string }> => {
    const { providers, providersVersion } = await service.get();
    return {
      providersVersion,
      providers: providers.map((p, index) => ({
        provider: p.provider,
        sourceIndex: index,
        ...(p.model ? { model: p.model } : {}),
        ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
      })),
    };
  };
  const raw = async () => {
    const current = await repo.read();
    if (!current) throw new Error('no config');
    return current;
  };
  return {
    service,
    rows,
    raw,
    text: async () => (await storage.read(PATH)) ?? '',
    configWrites: () => configWrites,
  };
}

describe('config.update — adopt on save', () => {
  it("adopts a saved row's model in the same write, says so, and keeps unrelated lines", async () => {
    const h = await harness(USER_CONFIG);
    const result = await h.service.update(await h.rows());
    expect(result.adoptedModels).toEqual([
      { alias: 'gpt-5-6-terra', providerKey: 'codex-gpt-terra', modelId: 'gpt-5.6-terra' },
    ]);
    expect(h.configWrites()).toBe(1);
    const raw = await h.raw();
    expect(raw.modelRegistry?.entries['gpt-5-6-terra']).toEqual({
      alias: 'gpt-5-6-terra',
      provider: 'codex-gpt-terra',
      modelId: 'gpt-5.6-terra',
    });
    expect(raw.modelRegistry?.default).toBe('gpt-5-6-terra');
    const text = await h.text();
    for (const line of [
      'provider: codex',
      'model: gpt-5.6-terra',
      'approvalMode: smart',
      'modelRouting.writer: default',
      'someTool.flag: kept',
      'providers.0.id: codex-gpt-terra',
    ]) {
      expect(text).toContain(line);
    }
  });

  it('a second save adopts nothing', async () => {
    const h = await harness(USER_CONFIG);
    await h.service.update(await h.rows());
    const again = await h.service.update(await h.rows());
    expect(again.adoptedModels).toEqual([]);
    expect(Object.keys((await h.raw()).modelRegistry?.entries ?? {})).toEqual(['gpt-5-6-terra']);
  });

  it('writes the id of an adopted id-less row', async () => {
    const h = await harness([
      'provider: openai',
      'model: gpt-4o',
      'providers.0.provider: openai',
      'providers.0.model: gpt-4o',
      'providers.1.provider: ollama',
      'providers.1.model: qwen3',
    ]);
    const result = await h.service.update(await h.rows());
    expect(result.adoptedModels).toEqual([
      { alias: 'gpt-4o', providerKey: 'openai', modelId: 'gpt-4o' },
      { alias: 'qwen3', providerKey: 'ollama-1', modelId: 'qwen3' },
    ]);
    const raw = await h.raw();
    expect(raw.providers.map((p) => p.id)).toEqual(['openai', 'ollama-1']);
    expect(raw.modelRegistry?.default).toBe('gpt-4o');
  });

  it('never adopts a row whose id was cleared in the same save', async () => {
    const h = await harness(USER_CONFIG);
    const { providers, providersVersion } = await h.rows();
    const result = await h.service.update({
      providersVersion,
      providers: providers.map((row) => ({ ...row, id: null })),
    });
    expect(result.adoptedModels).toEqual([]);
    const raw = await h.raw();
    expect(raw.providers[0]?.id).toBeUndefined();
    expect(raw.modelRegistry).toBeUndefined();
  });

  it('a save that sends no provider rows adopts nothing', async () => {
    const h = await harness(USER_CONFIG);
    const result = await h.service.update({ personality: 'engineer' });
    expect(result.adoptedModels).toEqual([]);
    expect((await h.raw()).modelRegistry).toBeUndefined();
  });

  it('the legacy single row never materializes a chain to adopt from', async () => {
    const h = await harness(['provider: anthropic', 'model: claude-sonnet-5']);
    const { providersVersion } = await h.rows();
    const result = await h.service.update({
      providersVersion,
      providers: [{ provider: 'anthropic', model: 'claude-sonnet-5' }],
    });
    expect(result.adoptedModels).toEqual([]);
    const raw = await h.raw();
    expect(raw.providers).toEqual([]);
    expect(raw.modelRegistry).toBeUndefined();
  });
});
