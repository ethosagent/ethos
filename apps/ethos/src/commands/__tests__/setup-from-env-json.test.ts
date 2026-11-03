import { FsStorage, InMemorySecretsResolver } from '@ethosagent/storage-fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSetupFromEnv } from '../setup-from-env';
import {
  EXIT,
  expectNoSecret,
  type JsonCliHarness,
  parseOneDoc,
  setupJsonCli,
} from './json-cli-harness';

// Task 17 (context-budget-2): `ethos setup --from-env --json` prints exactly one JSON document.
// Secrets are in memory; ETHOS_SKIP_VALIDATION=1 means no provider probe. The harness already
// wrote a config.yaml, so the run takes the "config preserved, secrets re-synced" branch.

vi.mock('../../wiring', () => ({
  getStorage: () => new FsStorage(),
  getSecretsResolver: async () => secrets,
  getFunnelTracker: () => ({ recordSetupCompleted: async () => {} }),
}));

let secrets: InMemorySecretsResolver;
let h: JsonCliHarness;
const ENV_KEYS = [
  'AZURE_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GOOGLE_API_KEY',
  'XAI_API_KEY',
  'TELEGRAM_BOT_TOKEN',
  'AZURE_ENDPOINT',
  'ETHOS_SKIP_VALIDATION',
];
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  h = await setupJsonCli('ethos-setupenv-json-');
  secrets = new InMemorySecretsResolver();
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.ETHOS_SKIP_VALIDATION = '1';
});

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await h.teardown();
});

describe('setup --from-env --json', () => {
  it('--json success is one JSON doc', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-secret-value';
    await runSetupFromEnv(['--from-env', '--json']);
    const doc = parseOneDoc(h);
    expect(doc).toMatchObject({
      ok: true,
      provider: 'anthropic',
      configWritten: false,
      telegram: false,
    });
    // The key is stored in the vault, never echoed.
    expect(await secrets.get('providers/anthropic/apiKey')).toBe('sk-ant-secret-value');
    expectNoSecret(h, 'sk-ant-secret-value');
  });

  it('--json with no provider key is one JSON doc', async () => {
    await expect(runSetupFromEnv(['--from-env', '--json'])).rejects.toThrow(`${EXIT}(1)`);
    const doc = parseOneDoc(h);
    expect(doc.ok).toBe(false);
    expect(doc.error?.code).toBe('CONFIG_MISSING');
  });

  it('--json azure without an endpoint is one JSON doc', async () => {
    process.env.AZURE_API_KEY = 'az';
    await expect(runSetupFromEnv(['--from-env', '--json'])).rejects.toThrow(`${EXIT}(1)`);
    expect(parseOneDoc(h).error?.code).toBe('CONFIG_MISSING');
  });
});
