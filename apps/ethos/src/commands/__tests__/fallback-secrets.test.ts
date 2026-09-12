import { join } from 'node:path';
import {
  type EthosConfig,
  ethosDir,
  type ProviderConfig,
  readConfig,
  readRawConfig,
  secretRefFromValue,
  writeConfig,
} from '@ethosagent/config';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import type { SecretsResolver, Storage } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runFallback } from '../fallback';

// `ethos fallback` reaches for the process-wide Storage / SecretsResolver.
// Swap both for in-memory doubles so config.yaml and the vault are inspectable.
const wiring = vi.hoisted(() => ({}) as { storage?: Storage; secrets?: SecretsResolver });

vi.mock('../../wiring', () => ({
  getStorage: () => wiring.storage,
  getSecretsResolver: async () => wiring.secrets,
}));

// `ethos fallback add` prompts through readline; answer from a queue instead.
const prompts = vi.hoisted(() => ({ answers: [] as string[] }));

vi.mock('node:readline', () => ({
  createInterface: () => ({
    question: (_prompt: string, cb: (answer: string) => void) => cb(prompts.answers.shift() ?? ''),
    close: () => {},
  }),
}));

// Assembled rather than written literally so the source doesn't carry a bare
// `${secrets:…}` string (Biome's noTemplateCurlyInString).
function secretRef(path: string): string {
  return ['${', 'secrets:', path, '}'].join('');
}

const BASE = {
  schemaVersion: 1,
  provider: 'anthropic',
  model: 'claude-opus-4-7',
  apiKey: 'sk-primary',
  personality: 'researcher',
} satisfies EthosConfig;

async function seed(
  providers: ProviderConfig[],
  secrets: SecretsResolver = new InMemorySecretsResolver(),
) {
  const storage = new InMemoryStorage();
  await writeConfig(storage, { ...BASE, providers }, secrets);
  wiring.storage = storage;
  wiring.secrets = secrets;
  return { storage, secrets };
}

async function chainOf(storage: Storage): Promise<ProviderConfig[]> {
  return (await readRawConfig(storage))?.providers ?? [];
}

describe('ethos fallback removes vault material with the config write first', () => {
  let logged: string[];

  beforeEach(() => {
    logged = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logged.push(args.join(' '));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('drops the removed entry’s ref and leaves the survivor resolvable', async () => {
    const { storage, secrets } = await seed([
      { provider: 'openrouter', apiKey: 'sk-or-1' },
      { provider: 'ollama', apiKey: 'sk-ol-2' },
    ]);
    const [first, second] = await chainOf(storage);
    const removedRef = first && secretRefFromValue(first.apiKey);
    const survivorRef = second && secretRefFromValue(second.apiKey);
    expect(removedRef).toBeTruthy();

    await runFallback(['remove', '1']);

    expect(await secrets.list()).not.toContain(removedRef);
    expect(await secrets.list()).toContain(survivorRef);
    expect(await chainOf(storage)).toEqual([
      { provider: 'ollama', apiKey: secretRef(survivorRef ?? '') },
    ]);
  });

  it('keeps the config write ahead of the delete — a failed write leaves the vault intact', async () => {
    const { storage, secrets } = await seed([
      { provider: 'openrouter', apiKey: 'sk-or-1' },
      { provider: 'ollama', apiKey: 'sk-ol-2' },
    ]);
    const before = await secrets.list();
    vi.spyOn(storage, 'write').mockRejectedValue(new Error('disk full'));

    await expect(runFallback(['remove', '1'])).rejects.toThrow('disk full');

    // Nothing was deleted: config still references every ref it did before.
    expect(await secrets.list()).toEqual(before);
  });

  it('keeps a ref a surviving entry still points at', async () => {
    // `add` mints `providers/<chain.length>/<provider>/apiKey`, so a removal
    // followed by an add can hand two entries the same ref.
    const secrets = new InMemorySecretsResolver();
    const storage = new InMemoryStorage();
    const shared = 'providers/1/openrouter/apiKey';
    await secrets.set(shared, 'sk-shared');
    await storage.mkdir(ethosDir());
    await storage.write(
      join(ethosDir(), 'config.yaml'),
      [
        'schemaVersion: 1',
        'provider: anthropic',
        'model: claude-opus-4-7',
        `apiKey: ${secretRef('providers/anthropic/apiKey')}`,
        'personality: researcher',
        'providers.0.provider: openrouter',
        `providers.0.apiKey: ${secretRef(shared)}`,
        'providers.1.provider: openrouter',
        `providers.1.apiKey: ${secretRef(shared)}`,
      ].join('\n'),
    );
    wiring.storage = storage;
    wiring.secrets = secrets;

    await runFallback(['remove', '1']);

    expect(await secrets.list()).toContain(shared);
    expect(await chainOf(storage)).toEqual([{ provider: 'openrouter', apiKey: secretRef(shared) }]);
  });

  // F01 follow-up: `add` used to mint `providers/<chain.length>/<provider>/apiKey`
  // itself and `set` it — which, after a removal, is the name a SURVIVING
  // entry still points at, so the new key silently replaced the survivor's.
  it('add after a remove does not overwrite a surviving entry key', async () => {
    const { storage, secrets } = await seed([
      { provider: 'anthropic', apiKey: 'sk-ant-first' },
      { provider: 'openrouter', apiKey: 'sk-or-survivor' },
    ]);
    await runFallback(['remove', '1']);

    // provider, API key, model, base URL
    prompts.answers = ['openrouter', 'sk-or-added', '', ''];
    await runFallback(['add']);

    const resolved = await Promise.all(
      (await chainOf(storage)).map(async (p) => secrets.get(secretRefFromValue(p.apiKey) ?? '')),
    );
    // The top-level primary leads: after the remove the chain had one entry,
    // so the add that grows it past one puts the primary in front.
    expect(resolved).toEqual(['sk-primary', 'sk-or-survivor', 'sk-or-added']);
  });

  // From a config with only top-level provider fields: the runtime takes the
  // chain over from two entries, so the first `add` must put the top-level
  // provider in front of the new fallback, not replace it.
  it('add on a top-level-only config keeps the top-level provider as primary', async () => {
    const storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();
    await writeConfig(storage, { ...BASE, baseUrl: 'https://proxy.example.com' }, secrets);
    wiring.storage = storage;
    wiring.secrets = secrets;

    prompts.answers = ['openrouter', 'sk-or-added', '', ''];
    await runFallback(['add']);

    const resolved = await readConfig(storage, secrets);
    expect(resolved?.providers).toMatchObject([
      {
        provider: 'anthropic',
        apiKey: 'sk-primary',
        model: 'claude-opus-4-7',
        baseUrl: 'https://proxy.example.com',
      },
      { provider: 'openrouter', apiKey: 'sk-or-added' },
    ]);
  });

  // `list` shows what the runtime runs: a chain of two or more replaces the
  // top-level fields, so the top-level provider is not listed again above it.
  it('list shows one primary — chain entry 1 once the chain is live', async () => {
    await seed([
      { provider: 'anthropic', apiKey: 'sk-primary' },
      { provider: 'openrouter', apiKey: 'sk-or-1' },
    ]);
    await runFallback(['list']);

    const out = plain(logged);
    expect(out.match(/Primary/g)).toHaveLength(1);
    expect(out).toContain('Primary (chain entry 1)');
    expect(out).toMatch(/1\. anthropic/);
    expect(out).toMatch(/Fallbacks[^\n]*\n\s+2\. openrouter/);
    // Listed once as a provider line (key refs also carry the name).
    expect(out.match(/^\s+(?:\d+\. )?anthropic ·/gm)).toHaveLength(1);
  });

  it('list shows the top-level primary while the chain has fewer than two entries', async () => {
    await seed([]);
    await runFallback(['list']);

    const out = plain(logged);
    expect(out.match(/Primary/g)).toHaveLength(1);
    expect(out).toContain('Primary (from top-level provider/apiKey/model)');
    expect(out).toContain('No fallback providers configured.');
  });

  // verify final-f01/cli2: a provider move on the web writes chain entry 0's
  // index-named reference into the TOP-LEVEL apiKey; the chain writer must
  // count it as taken, or a later add mints the same name over the top key.
  it('a later add never overwrites a top-level key that names a chain-style secret', async () => {
    const storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();
    await secrets.set('providers/1/openai/apiKey', 'sk-oai-ORIG');
    await storage.mkdir(ethosDir());
    await storage.write(
      join(ethosDir(), 'config.yaml'),
      [
        'schemaVersion: 1',
        'provider: openai',
        'model: gpt-4o',
        `apiKey: ${secretRef('providers/1/openai/apiKey')}`,
        'personality: researcher',
        '',
      ].join('\n'),
    );
    wiring.storage = storage;
    wiring.secrets = secrets;

    prompts.answers = ['openai', 'sk-oai-O2', '', ''];
    await runFallback(['add']);
    await runFallback(['remove', '1']);
    prompts.answers = ['openai', 'sk-oai-O3', '', ''];
    await runFallback(['add']);

    expect((await readConfig(storage, secrets))?.apiKey).toBe('sk-oai-ORIG');
    expect(await secrets.get('providers/1/openai/apiKey')).toBe('sk-oai-ORIG');
  });

  // Canonical by-name secrets are read directly by provider factories and
  // tools; `remove` must never delete one, even when no line names it now.
  it('remove never deletes a canonical by-name secret', async () => {
    const storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();
    await secrets.set('providers/openai/apiKey', 'sk-openai-canonical');
    await storage.mkdir(ethosDir());
    await storage.write(
      join(ethosDir(), 'config.yaml'),
      [
        'schemaVersion: 1',
        'provider: anthropic',
        'model: claude-opus-4-7',
        'personality: researcher',
        'providers.0.provider: openai',
        `providers.0.apiKey: ${secretRef('providers/openai/apiKey')}`,
        'providers.1.provider: ollama',
        '',
      ].join('\n'),
    );
    wiring.storage = storage;
    wiring.secrets = secrets;

    await runFallback(['remove', '1']);
    expect(await secrets.get('providers/openai/apiKey')).toBe('sk-openai-canonical');
  });

  // Nothing could author `providers.<i>.region` / `.awsProfile` for a fallback,
  // so a Bedrock fallback ran in us-east-1 whatever the operator meant.
  it('add asks a Bedrock fallback for its region and profile', async () => {
    const { storage } = await seed([{ provider: 'openrouter', apiKey: 'sk-or-1' }]);
    // provider · key · model · baseUrl · region · awsProfile
    prompts.answers = ['bedrock', 'bedrock-key-1', '', '', 'eu-west-1', 'sso-prod'];
    await runFallback(['add']);

    const chain = await chainOf(storage);
    expect(chain.at(-1)).toMatchObject({
      provider: 'bedrock',
      region: 'eu-west-1',
      awsProfile: 'sso-prod',
    });
  });

  it('asks an Azure fallback for its api version, and neither for openrouter', async () => {
    const { storage } = await seed([{ provider: 'openrouter', apiKey: 'sk-or-1' }]);
    prompts.answers = ['azure', 'azure-key-1', '', 'https://x.openai.azure.com', '2024-10-21'];
    await runFallback(['add']);
    prompts.answers = ['openrouter', 'sk-or-2', '', ''];
    await runFallback(['add']);

    const chain = await chainOf(storage);
    expect(chain.find((p) => p.provider === 'azure')).toMatchObject({ apiVersion: '2024-10-21' });
    const added = chain.filter((p) => p.provider === 'openrouter').at(-1);
    expect(added?.region).toBeUndefined();
    expect(added?.apiVersion).toBeUndefined();
  });

  it('list shows every field an entry carries, and names its unknown keys', async () => {
    const secrets = new InMemorySecretsResolver();
    const storage = new InMemoryStorage();
    await writeConfig(
      storage,
      {
        ...BASE,
        providers: [
          { provider: 'anthropic', apiKey: 'sk-ant-1', model: 'claude-opus-4-7' },
          {
            provider: 'bedrock',
            apiKey: '',
            region: 'eu-west-1',
            awsProfile: 'sso-prod',
            apiVersion: '2024-10-21',
            passthrough: { inferenceProfileArn: 'arn:aws:x' },
          },
        ],
      },
      secrets,
    );
    wiring.storage = storage;
    wiring.secrets = secrets;

    await runFallback(['list']);

    const out = plain(logged);
    expect(out).toContain('eu-west-1');
    expect(out).toContain('sso-prod');
    expect(out).toContain('2024-10-21');
    expect(out).toContain('inferenceProfileArn');
  });

  it('still removes the entry when the vault delete fails, and says so', async () => {
    const secrets = new InMemorySecretsResolver() as SecretsResolver;
    const { storage } = await seed([{ provider: 'openrouter', apiKey: 'sk-or-1' }], secrets);
    const [first] = await chainOf(storage);
    const removedRef = first && secretRefFromValue(first.apiKey);
    vi.spyOn(secrets, 'delete').mockRejectedValue(new Error('vault is read-only'));

    await expect(runFallback(['remove', '1'])).resolves.toBeUndefined();

    expect(await chainOf(storage)).toEqual([]);
    const warning = logged.join('\n');
    expect(warning).toContain('vault is read-only');
    expect(warning).toContain(`ethos secrets remove ${removedRef}`);
  });

  it('clear drops every ref, and surfaces a failed delete instead of swallowing it', async () => {
    const secrets = new InMemorySecretsResolver() as SecretsResolver;
    const { storage } = await seed(
      [
        { provider: 'openrouter', apiKey: 'sk-or-1' },
        { provider: 'ollama', apiKey: 'sk-ol-2' },
      ],
      secrets,
    );
    const chain = await chainOf(storage);
    const refs = chain.map((p) => secretRefFromValue(p.apiKey));

    await runFallback(['clear']);

    expect(await chainOf(storage)).toEqual([]);
    for (const ref of refs) expect(await secrets.list()).not.toContain(ref);

    // Same again, with the vault refusing.
    const { storage: storage2 } = await seed(
      [{ provider: 'openrouter', apiKey: 'sk-or-1' }],
      secrets,
    );
    const [only] = await chainOf(storage2);
    const ref = only && secretRefFromValue(only.apiKey);
    vi.spyOn(secrets, 'delete').mockRejectedValue(new Error('vault is read-only'));

    await expect(runFallback(['clear'])).resolves.toBeUndefined();

    expect(await chainOf(storage2)).toEqual([]);
    const warning = logged.join('\n');
    expect(warning).toContain('vault is read-only');
    expect(warning).toContain(`ethos secrets remove ${ref}`);
  });
});

/** Captured console output without ANSI colour codes. */
function plain(lines: readonly string[]): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes.
  return lines.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
}
