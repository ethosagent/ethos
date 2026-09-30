// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${secrets:…}` refs are literal config text, not templates
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The B4 test below drives the full runSetupFromEnv path against an in-memory
// storage, so the CLI wiring singletons are replaced; the pure-helper tests
// above it never touch them.
const secretStore = new Map<string, string>();
const memStorageHolder: { storage?: import('@ethosagent/storage-fs').InMemoryStorage } = {};
vi.mock('../wiring', () => ({
  getStorage: () => memStorageHolder.storage,
  getSecretsResolver: async () => ({
    get: async (ref: string) => secretStore.get(ref) ?? null,
    set: async (ref: string, value: string) => {
      secretStore.set(ref, value);
    },
    delete: async (ref: string) => {
      secretStore.delete(ref);
    },
    list: async () => [...secretStore.keys()],
  }),
  getFunnelTracker: () => ({ recordSetupCompleted: async () => {} }),
}));

import { loadConfigStrict } from '@ethosagent/config';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import {
  INIT_SUCCESS_LINE,
  providerRejectedLine,
  resolveProviderFromEnv,
  runSetupFromEnv,
} from '../commands/setup-from-env';

describe('resolveProviderFromEnv — W2.4 provider matrix', () => {
  it('returns null when no provider key is set', () => {
    expect(resolveProviderFromEnv({})).toBeNull();
  });

  it('resolves Anthropic', () => {
    const p = resolveProviderFromEnv({ ANTHROPIC_API_KEY: 'sk-ant' });
    expect(p).toMatchObject({
      provider: 'anthropic',
      apiKey: 'sk-ant',
      envVar: 'ANTHROPIC_API_KEY',
    });
  });

  it('honors precedence: Azure over Anthropic over OpenAI over OpenRouter over Google', () => {
    const p = resolveProviderFromEnv({
      AZURE_API_KEY: 'az',
      AZURE_ENDPOINT: 'https://x.openai.azure.com',
      ANTHROPIC_API_KEY: 'sk-ant',
      OPENAI_API_KEY: 'sk-oai',
      OPENROUTER_API_KEY: 'or',
      GOOGLE_API_KEY: 'g',
    });
    expect(p?.provider).toBe('azure');
    expect(p?.baseUrl).toBe('https://x.openai.azure.com');

    expect(resolveProviderFromEnv({ ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' })?.provider).toBe(
      'anthropic',
    );
    expect(resolveProviderFromEnv({ OPENAI_API_KEY: 'o', OPENROUTER_API_KEY: 'r' })?.provider).toBe(
      'openai',
    );
    expect(resolveProviderFromEnv({ OPENROUTER_API_KEY: 'r', GOOGLE_API_KEY: 'g' })?.provider).toBe(
      'openrouter',
    );
    expect(resolveProviderFromEnv({ GOOGLE_API_KEY: 'g' })?.provider).toBe('gemini');
    expect(resolveProviderFromEnv({ GOOGLE_API_KEY: 'g', XAI_API_KEY: 'x' })?.provider).toBe(
      'gemini',
    );
    expect(resolveProviderFromEnv({ XAI_API_KEY: 'x' })?.provider).toBe('xai');
  });

  it('defaults a model per provider and passes OpenRouter model through', () => {
    expect(resolveProviderFromEnv({ ANTHROPIC_API_KEY: 'a' })?.model).toBe('claude-opus-5-5');
    expect(resolveProviderFromEnv({ OPENAI_API_KEY: 'o' })?.model).toBe('gpt-6-sol');
    expect(resolveProviderFromEnv({ GOOGLE_API_KEY: 'g' })?.model).toBe('gemini-3.8-flash');
    expect(resolveProviderFromEnv({ XAI_API_KEY: 'x' })?.model).toBe('grok-4.7');
    expect(
      resolveProviderFromEnv({ OPENROUTER_API_KEY: 'r', OPENROUTER_MODEL: 'x/y' })?.model,
    ).toBe('x/y');
  });

  it('resolves OpenRouter / Gemini base URLs from the catalog', () => {
    expect(resolveProviderFromEnv({ OPENROUTER_API_KEY: 'r' })?.baseUrl).toContain('openrouter.ai');
    expect(resolveProviderFromEnv({ GOOGLE_API_KEY: 'g' })?.baseUrl).toContain(
      'generativelanguage.googleapis.com',
    );
  });

  it('carries AZURE_OUTPUT_CAP_PARAM only when it is one of the two accepted values', () => {
    const base = { AZURE_API_KEY: 'az', AZURE_ENDPOINT: 'https://x.openai.azure.com' };
    expect(
      resolveProviderFromEnv({ ...base, AZURE_OUTPUT_CAP_PARAM: 'max_completion_tokens' })
        ?.outputCapParam,
    ).toBe('max_completion_tokens');
    expect(
      resolveProviderFromEnv({ ...base, AZURE_OUTPUT_CAP_PARAM: 'max_tokens' })?.outputCapParam,
    ).toBe('max_tokens');
    expect(resolveProviderFromEnv(base)?.outputCapParam).toBeUndefined();
    // The invalid non-empty case reads as absent HERE; `runSetupFromEnv`
    // refuses it fail-closed before anything is written (tested below).
    expect(
      resolveProviderFromEnv({ ...base, AZURE_OUTPUT_CAP_PARAM: 'max_output_tokens' })
        ?.outputCapParam,
    ).toBeUndefined();
  });
});

// The init last-line contract (W1.3 / Z-T14). These verbatim strings are the
// only line a first-run `docker compose up` user reliably reads; the F3 exit
// criteria assert them exactly, so lock them against drift here.
describe('init last-line contract — W1.3', () => {
  it('emits the exact success line', () => {
    expect(INIT_SUCCESS_LINE).toBe('✓ Config validated — web UI: http://localhost:3000');
  });

  it('names the concrete env var + next action on rejection, per provider', () => {
    expect(providerRejectedLine('ANTHROPIC_API_KEY')).toBe(
      'ANTHROPIC_API_KEY rejected (401) — check the key in .env and re-run docker compose up',
    );
    expect(providerRejectedLine('OPENAI_API_KEY')).toBe(
      'OPENAI_API_KEY rejected (401) — check the key in .env and re-run docker compose up',
    );
  });

  it('failure line follows DESIGN.md voice — no exclamation, ✗-free, actionable', () => {
    const line = providerRejectedLine('AZURE_API_KEY');
    expect(line).not.toContain('!');
    expect(line).toContain('re-run docker compose up');
  });
});

// B4 (plan ux-feedback-and-config-clarity) — the from-env bootstrap writes the
// `telegram.bots.0.*` list form, never the deprecated `telegramToken` scalar.
describe('runSetupFromEnv — B4 telegram list form', () => {
  const STATE_DIR = '/tmp/ethos-from-env-b4-test';
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = {
      PATH: ORIGINAL_ENV.PATH,
      ETHOS_STATE_DIR: STATE_DIR,
      ETHOS_SKIP_VALIDATION: '1',
      ANTHROPIC_API_KEY: 'sk-ant-x',
      TELEGRAM_BOT_TOKEN: '123:ABC',
    };
    secretStore.clear();
    memStorageHolder.storage = new InMemoryStorage();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.restoreAllMocks();
  });

  it('writes telegram.bots.0.* with a personality bind and zero deprecations', async () => {
    await runSetupFromEnv();

    const storage = memStorageHolder.storage;
    expect(storage).toBeDefined();
    const text = (await storage?.read(join(STATE_DIR, 'config.yaml'))) ?? '';
    expect(text).toContain('telegram.bots.0.token: ${secrets:telegram/token}');
    expect(text).toContain('telegram.bots.0.bind.type: personality');
    expect(text).toContain('telegram.bots.0.bind.name: researcher');
    expect(text).not.toContain('telegramToken:');
    expect(text).not.toContain('123:ABC');
    expect(secretStore.get('telegram/token')).toBe('123:ABC');

    if (!storage) throw new Error('storage not constructed');
    const loaded = await loadConfigStrict(storage);
    expect(loaded?.parseErrors).toEqual([]);
    expect(loaded?.deprecations).toEqual([]);
  });
});

// AZURE_OUTPUT_CAP_PARAM — a reasoning model deployed under a non-family name
// needs `outputCapParam: max_completion_tokens`, and it has no top-level
// spelling: the primary's is chain entry 0, so the provisioned config carries
// a minimal `providers.0` entry (V-CP-5).
describe('runSetupFromEnv — AZURE_OUTPUT_CAP_PARAM', () => {
  const STATE_DIR = '/tmp/ethos-from-env-azure-cap-test';
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = {
      PATH: ORIGINAL_ENV.PATH,
      ETHOS_STATE_DIR: STATE_DIR,
      ETHOS_SKIP_VALIDATION: '1',
      AZURE_API_KEY: 'az-key',
      AZURE_ENDPOINT: 'https://x.openai.azure.com',
      AZURE_MODEL: 'gpt-6-sol',
    };
    secretStore.clear();
    memStorageHolder.storage = new InMemoryStorage();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.restoreAllMocks();
  });

  async function writtenConfig(): Promise<string> {
    const storage = memStorageHolder.storage;
    if (!storage) throw new Error('storage not constructed');
    return (await storage.read(join(STATE_DIR, 'config.yaml'))) ?? '';
  }

  it('provisions providers.0.outputCapParam when the value is valid', async () => {
    process.env.AZURE_OUTPUT_CAP_PARAM = 'max_completion_tokens';
    await runSetupFromEnv();

    const text = await writtenConfig();
    expect(text).toContain('providers.0.provider: azure');
    expect(text).toContain('providers.0.outputCapParam: max_completion_tokens');

    const storage = memStorageHolder.storage;
    if (!storage) throw new Error('storage not constructed');
    const loaded = await loadConfigStrict(storage);
    expect(loaded?.parseErrors).toEqual([]);
    expect(loaded?.deprecations).toEqual([]);
    expect(loaded?.config.providers?.[0]?.outputCapParam).toBe('max_completion_tokens');
  });

  it('omits the key entirely when AZURE_OUTPUT_CAP_PARAM is absent', async () => {
    await runSetupFromEnv();
    const text = await writtenConfig();
    expect(text).not.toContain('outputCapParam');
    expect(text).not.toContain('providers.0.');
  });

  it('refuses an invalid value with a named error before writing anything', async () => {
    process.env.AZURE_OUTPUT_CAP_PARAM = 'max_output_tokens';
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit(1)');
    });

    await expect(runSetupFromEnv()).rejects.toThrow('process.exit(1)');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(
      "AZURE_OUTPUT_CAP_PARAM must be max_tokens or max_completion_tokens (got 'max_output_tokens') — fix .env and re-run docker compose up.",
    );
    expect(await writtenConfig()).toBe('');
  });
});
