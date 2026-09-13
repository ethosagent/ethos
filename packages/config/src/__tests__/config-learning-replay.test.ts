import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import {
  type EthosConfig,
  ethosDir,
  LEARNING_REPLAY_DEFAULTS,
  readRawConfig,
  resolveLearningReplay,
  writeConfig,
} from '../index';

// `learningReplay.*` — the replay-gated learning budget block
// (plan/phases/trust-before-reach.md L-D8). Operator settings; nothing here
// touches `PersonalityConfig`.

const BASE = ['provider: anthropic', 'model: m', 'apiKey: sk', 'personality: researcher'];

async function seed(lines: string[]): Promise<InMemoryStorage> {
  const storage = new InMemoryStorage();
  await storage.mkdir(ethosDir());
  await storage.write(join(ethosDir(), 'config.yaml'), `${[...BASE, ...lines].join('\n')}\n`);
  return storage;
}

async function load(lines: string[]): Promise<EthosConfig> {
  const cfg = await readRawConfig(await seed(lines));
  if (!cfg) throw new Error('readRawConfig returned null');
  return cfg;
}

async function fileOf(storage: InMemoryStorage): Promise<string> {
  const src = await storage.read(join(ethosDir(), 'config.yaml'));
  if (src === null) throw new Error('config.yaml missing');
  return src;
}

const ALL = [
  'learningReplay.enabled: true',
  'learningReplay.maxCases: 8',
  'learningReplay.maxCostUsd: 0.5',
  'learningReplay.maxCandidatesPerRun: 5',
];

describe('learningReplay config', () => {
  it('is absent when no learningReplay.* key is set', async () => {
    expect((await load([])).learningReplay).toBeUndefined();
  });

  it('applies the L-D8 defaults when the keys are absent', async () => {
    expect(resolveLearningReplay(await load([]))).toEqual({
      enabled: true,
      maxCases: 8,
      maxCostUsd: 0.5,
      maxCandidatesPerRun: 5,
    });
    // Named literally, not derived: the point of the assertion is that these
    // four numbers are the ones L-D8 decided.
    expect(LEARNING_REPLAY_DEFAULTS).toEqual({
      enabled: true,
      maxCases: 8,
      maxCostUsd: 0.5,
      maxCandidatesPerRun: 5,
    });
  });

  it('parses every field', async () => {
    const cfg = await load([
      'learningReplay.enabled: false',
      'learningReplay.maxCases: 5',
      'learningReplay.maxCostUsd: 1.25',
      'learningReplay.maxCandidatesPerRun: 2',
    ]);
    expect(cfg.learningReplay).toEqual({
      enabled: false,
      maxCases: 5,
      maxCostUsd: 1.25,
      maxCandidatesPerRun: 2,
    });
  });

  it('lets an explicitly-set value survive, defaulting only the rest', async () => {
    const cfg = await load(['learningReplay.maxCostUsd: 2']);
    expect(cfg.learningReplay).toEqual({ maxCostUsd: 2 });
    expect(resolveLearningReplay(cfg)).toEqual({
      enabled: true,
      maxCases: 8,
      maxCostUsd: 2,
      maxCandidatesPerRun: 5,
    });
  });

  // A value equal to a default is still an explicit setting, and the operator
  // gets to see it in their file: the block is never rewritten from defaults.
  it('keeps a value the operator set to the default', async () => {
    const cfg = await load(['learningReplay.maxCases: 8']);
    expect(cfg.learningReplay).toEqual({ maxCases: 8 });
  });

  it('treats a non-"true" enabled as false, like every other boolean here', async () => {
    expect((await load(['learningReplay.enabled: no'])).learningReplay?.enabled).toBe(false);
    expect((await load(['learningReplay.enabled: true'])).learningReplay?.enabled).toBe(true);
  });

  it('refuses a case cap below the verdict rule floor of 3', async () => {
    await expect(load(['learningReplay.maxCases: 2'])).rejects.toThrow(
      /learningReplay\.maxCases "2"\. Expected an integer of 3 or more/,
    );
    await expect(load(['learningReplay.maxCases: 0'])).rejects.toThrow(/3 or more/);
  });

  // Same failure `backup.keep` and `channelDigest.*` had: `parseInt` and
  // `parseFloat` stop at the first character they cannot use.
  it('refuses numbers with trailing junk rather than parsing their prefix', async () => {
    await expect(load(['learningReplay.maxCases: 8 cases'])).rejects.toThrow(
      /learningReplay\.maxCases "8 cases"/,
    );
    await expect(load(['learningReplay.maxCostUsd: 0.5usd'])).rejects.toThrow(
      /learningReplay\.maxCostUsd "0\.5usd"/,
    );
    await expect(load(['learningReplay.maxCandidatesPerRun: 5 per night'])).rejects.toThrow(
      /learningReplay\.maxCandidatesPerRun "5 per night"/,
    );
  });

  it('refuses a zero or negative budget', async () => {
    await expect(load(['learningReplay.maxCostUsd: 0'])).rejects.toThrow(/positive number/);
    await expect(load(['learningReplay.maxCostUsd: -1'])).rejects.toThrow(
      /learningReplay\.maxCostUsd "-1"/,
    );
    await expect(load(['learningReplay.maxCandidatesPerRun: 0'])).rejects.toThrow(
      /positive integer/,
    );
  });

  // Byte-identical against a file this serializer wrote. A hand-written seed
  // is not the right baseline: `writeConfig` also stamps `schemaVersion` and
  // moves `apiKey` into the vault, which it would do with or without this
  // block. What has to hold is that reading the written file and writing it
  // back changes nothing — the four keys survive verbatim, in place.
  it('a parse → serialize round trip is byte-identical', async () => {
    const storage = await seed(ALL);
    const first = await readRawConfig(storage);
    if (!first) throw new Error('config did not parse');
    await writeConfig(storage, first, new InMemorySecretsResolver());
    const canonical = await fileOf(storage);
    for (const line of ALL) expect(canonical.split('\n')).toContain(line);

    const second = await readRawConfig(storage);
    if (!second) throw new Error('written config did not parse');
    await writeConfig(storage, second, new InMemorySecretsResolver());

    expect(await fileOf(storage)).toBe(canonical);
    expect(second.learningReplay).toEqual(first.learningReplay);
  });

  it('an unknown leaf under the namespace is preserved, not dropped', async () => {
    const storage = await seed([...ALL, 'learningReplay.somethingNew: 42']);
    const cfg = await readRawConfig(storage);
    if (!cfg) throw new Error('config did not parse');
    // Not modelled, so it is not on the parsed object …
    expect(cfg.learningReplay).not.toHaveProperty('somethingNew');

    await writeConfig(storage, cfg, new InMemorySecretsResolver());

    // … but the operator's line survives the write, like every other key this
    // serializer cannot express (`unexpressibleLines`).
    expect((await fileOf(storage)).split('\n')).toContain('learningReplay.somethingNew: 42');
  });

  it('clearing the block deletes its lines', async () => {
    const storage = await seed(ALL);
    const cfg = await readRawConfig(storage);
    if (!cfg) throw new Error('config did not parse');

    await writeConfig(
      storage,
      { ...cfg, learningReplay: undefined },
      new InMemorySecretsResolver(),
    );

    const after = await fileOf(storage);
    expect(after).not.toContain('learningReplay.');
  });
});
