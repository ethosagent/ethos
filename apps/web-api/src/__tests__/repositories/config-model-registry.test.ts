// T2.1 (plan/phases/model-registry.md): the web repository reads and writes
// `modelRegistry.*` and `providers.<n>.id` / `failover` through the codec
// `@ethosagent/config` shares with the CLI, so a settings save made in the web
// UI can never delete a registry line or a provider entry's identity.

import { join } from 'node:path';
import { parseConfigYaml } from '@ethosagent/config';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { ConfigRepository } from '../../repositories/config.repository';
import { ConfigService } from '../../services/config.service';

const DATA = '/data';
const PATH = join(DATA, 'config.yaml');

const FILE = [
  'provider: anthropic',
  'model: claude-sonnet-5',
  'personality: researcher',
  'providers.0.provider: anthropic',
  'providers.0.id: anthropic-work',
  'providers.0.apiKey: sk-ant-work-0123456789',
  'providers.1.provider: ollama',
  'providers.1.id: local',
  'providers.1.baseUrl: http://127.0.0.1:11434/v1',
  'providers.1.failover: false',
  // Entries deliberately NOT alphabetical: file order is part of what survives.
  'modelRegistry.sonnet.provider: anthropic-work',
  'modelRegistry.sonnet.modelId: claude-sonnet-5',
  'modelRegistry.sonnet.label: "everyday: driver"',
  'modelRegistry.sonnet.contextWindow: 200000',
  'modelRegistry.sonnet.costPer1kInput: 0.003',
  'modelRegistry.sonnet.costPer1kOutput: 0.015',
  // A leaf the codec does not model — must ride along untouched.
  'modelRegistry.sonnet.futureKnob: keep-me',
  'modelRegistry.opus.provider: anthropic-work',
  'modelRegistry.opus.modelId: claude-opus-5',
  'modelRegistry.opus.fallbacks: sonnet',
  'modelRegistry.qwen.provider: local',
  'modelRegistry.qwen.modelId: qwen2.5-coder:32b',
  'modelRegistry.default: sonnet',
  'modelRegistry.roles.deep: opus',
  'modelRegistry.roles.dreaming: qwen',
];

async function setup() {
  const storage = new InMemoryStorage();
  const secrets = new InMemorySecretsResolver();
  await storage.mkdir(DATA);
  await storage.write(PATH, `${FILE.join('\n')}\n`);
  const repo = new ConfigRepository({ dataDir: DATA, storage, secrets });
  return { storage, secrets, repo };
}

describe('ConfigRepository — modelRegistry (T2.1)', () => {
  it('an unrelated setting save preserves every registry entry and its unmodelled fields', async () => {
    const { storage, repo } = await setup();
    const before = parseConfigYaml((await storage.read(PATH)) ?? '').modelRegistry;
    expect(Object.keys(before?.entries ?? {})).toEqual(['sonnet', 'opus', 'qwen']);

    const read = await repo.read();
    expect(read?.modelRegistry).toEqual(before);
    // The unmodelled leaf is not claimed by the codec, so it is passthrough.
    expect(read?.passthrough['modelRegistry.sonnet.futureKnob']).toBe('keep-me');
    expect(
      Object.keys(read?.passthrough ?? {}).filter((k) => k !== 'modelRegistry.sonnet.futureKnob'),
    ).not.toContain('modelRegistry.sonnet.provider');

    await repo.update({ verbosity: 'verbose' });
    await repo.update({ modelRouting: { researcher: 'deep' } });

    const src = (await storage.read(PATH)) ?? '';
    const after = parseConfigYaml(src);
    expect((await repo.read())?.verbosity).toBe('verbose');
    expect(after.modelRegistry).toEqual(before);
    expect(Object.keys(after.modelRegistry?.entries ?? {})).toEqual(['sonnet', 'opus', 'qwen']);
    expect(src).toContain('modelRegistry.sonnet.futureKnob: keep-me');
    // A label carrying a colon is quoted by this writer and reads back intact.
    expect(after.modelRegistry?.entries.sonnet?.label).toBe('everyday: driver');
    // Each line written exactly once — nothing duplicated into passthrough.
    expect(src.match(/^modelRegistry\.sonnet\.provider:/gm)).toHaveLength(1);
  });

  it("a provider entry's id and failover flag survive a settings save that touches neither", async () => {
    const { storage, secrets, repo } = await setup();
    const service = new ConfigService({ config: repo, secrets });

    // What the Settings page sends today: provider / model / baseUrl and the
    // source index, and no `id` or `failover` at all.
    const { providers, providersVersion } = await service.get();
    expect(providers.map((p) => [p.id, p.failover])).toEqual([
      ['anthropic-work', true],
      ['local', false],
    ]);
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

    const chain = parseConfigYaml((await storage.read(PATH)) ?? '').providers ?? [];
    expect(chain.map((e) => [e.id, e.failover])).toEqual([
      ['anthropic-work', undefined],
      ['local', false],
    ]);
    expect(
      parseConfigYaml((await storage.read(PATH)) ?? '').modelRegistry?.entries.qwen?.provider,
    ).toBe('local');
  });

  it('a row can set id and failover, and renaming a referenced id is refused naming the aliases', async () => {
    const { storage, secrets, repo } = await setup();
    const service = new ConfigService({ config: repo, secrets });
    const load = async () => {
      const got = await service.get();
      return {
        version: got.providersVersion,
        rows: got.providers.map((p, i) => ({
          provider: p.provider,
          sourceIndex: i,
          ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
        })),
      };
    };

    const renamed = await load();
    await expect(
      service.update({
        providersVersion: renamed.version,
        providers: renamed.rows.map((r, i) => (i === 1 ? { ...r, id: 'ollama-box' } : r)),
      }),
    ).rejects.toThrow(/"local" is used by the model qwen/);

    const flags = await load();
    await service.update({
      providersVersion: flags.version,
      providers: flags.rows.map((r, i) =>
        i === 0 ? { ...r, failover: false } : { ...r, failover: true },
      ),
    });
    const chain = parseConfigYaml((await storage.read(PATH)) ?? '').providers ?? [];
    // `true` removes a stored `false` (absence means true); `false` is written.
    expect(chain.map((e) => [e.id, e.failover])).toEqual([
      ['anthropic-work', false],
      ['local', undefined],
    ]);

    const dup = await load();
    await expect(
      service.update({
        providersVersion: dup.version,
        providers: dup.rows.map((r) => ({ ...r, id: 'same' })),
      }),
    ).rejects.toThrow(/already another provider row's id/);
  });
});
